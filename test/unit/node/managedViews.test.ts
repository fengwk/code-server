import { EventEmitter } from "events"
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import {
  canonicalWorkspacePath,
  isLoopbackAddress,
  ManagedViewError,
  ManagedViewManager,
  ManagedViewRuntime,
  ManagedViewRuntimeClose,
  ManagedViewRuntimeInspection,
  ManagedViewRuntimeRebind,
  ManagedViewRuntimeRegistration,
  managementTokenMatches,
  normalizeBindingEpoch,
  normalizeViewId,
  parseCloseBody,
  parseRegisterBody,
} from "../../../src/node/managedViews"

const VIEW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const VIEW_B = "22222222-2222-4222-8222-222222222222"

class FakeResource extends EventEmitter {
  destroyed = false
  constructor(private readonly closeOnDestroy = true) {
    super()
  }
  destroy(): void {
    this.destroyed = true
    if (this.closeOnDestroy) {
      this.emit("close")
    }
  }
}

class FakeRuntime implements ManagedViewRuntime {
  readonly registrations: string[] = []
  readonly rebinds: string[] = []
  readonly closes: string[] = []
  readonly records = new Map<string, ManagedViewRuntimeInspection>()
  failClose = false
  failRebind = false
  async registerView(
    viewId: string,
    bindingEpoch: string,
    workspacePath: string,
  ): Promise<ManagedViewRuntimeRegistration> {
    this.registrations.push(`${viewId}:${bindingEpoch}`)
    if (!this.records.has(viewId)) {
      this.records.set(viewId, {
        viewId,
        bindingEpoch,
        workspacePath,
        state: "OPEN",
        dirty: "unknown",
        draftBackup: { supported: false, reason: "test" },
        managementConnections: [{ id: "management-1" }],
        extensionHosts: [{ id: "extension-1", pid: 1234 }],
        terminals: [{ id: 7, pid: 1235 }],
        failures: [],
      })
    }
    return { viewId, bindingEpoch, workspacePath, state: "OPEN", created: true }
  }
  async rebindView(
    viewId: string,
    fromBindingEpoch: string,
    bindingEpoch: string,
    workspacePath: string,
  ): Promise<ManagedViewRuntimeRebind> {
    this.rebinds.push(`${viewId}:${fromBindingEpoch}->${bindingEpoch}`)
    const record = this.records.get(viewId)
    if (!record || record.bindingEpoch !== fromBindingEpoch || record.workspacePath !== workspacePath) {
      throw new Error("missing")
    }
    if (this.failRebind) {
      record.state = "CLEANUP_FAILED"
      record.failures = ["extension host did not exit"]
      return {
        state: "CLEANUP_FAILED",
        failures: ["extension host did not exit"],
        releasedManagementConnections: 0,
        releasedExtensionHosts: 0,
        preservedTerminals: record.terminals.length,
      }
    }
    const preservedTerminals = record.terminals.length
    record.bindingEpoch = bindingEpoch
    record.state = "OPEN"
    record.managementConnections = []
    record.extensionHosts = []
    record.failures = []
    return {
      state: "OPEN",
      failures: [],
      releasedManagementConnections: 1,
      releasedExtensionHosts: 1,
      preservedTerminals,
    }
  }
  async inspectView(viewId: string, bindingEpoch: string): Promise<ManagedViewRuntimeInspection> {
    const record = this.records.get(viewId)
    if (!record || record.bindingEpoch !== bindingEpoch) {
      throw new Error("missing")
    }
    return { ...record }
  }
  async closeView(viewId: string): Promise<ManagedViewRuntimeClose> {
    this.closes.push(viewId)
    if (this.failClose) {
      return {
        state: "CLEANUP_FAILED",
        failures: ["extension host did not exit"],
        releasedManagementConnections: 0,
        releasedExtensionHosts: 0,
        releasedTerminals: 0,
      }
    }
    this.records.delete(viewId)
    return {
      state: "CLOSED",
      failures: [],
      releasedManagementConnections: 1,
      releasedExtensionHosts: 1,
      releasedTerminals: 1,
    }
  }
  async listViews(): Promise<ManagedViewRuntimeInspection[]> {
    return [...this.records.values()]
  }
}

describe("managed view validation", () => {
  test("accepts only canonical view ids and positive long epochs", () => {
    expect(normalizeViewId(VIEW_A)).toBe(VIEW_A)
    expect(() => normalizeViewId(VIEW_A.toUpperCase())).toThrow(ManagedViewError)
    expect(normalizeBindingEpoch("1")).toBe("1")
    expect(normalizeBindingEpoch("9223372036854775807")).toBe("9223372036854775807")
    expect(() => normalizeBindingEpoch("0")).toThrow(ManagedViewError)
    expect(() => normalizeBindingEpoch("01")).toThrow(ManagedViewError)
    expect(() => normalizeBindingEpoch("9223372036854775808")).toThrow(ManagedViewError)
    expect(() => normalizeBindingEpoch(1)).toThrow(ManagedViewError)
  })

  test("rejects unknown fields and unsupported modes", () => {
    expect(() => parseRegisterBody({ bindingEpoch: "1", workspacePath: "/tmp" })).not.toThrow()
    expect(() => parseRegisterBody({ bindingEpoch: "1", workspacePath: "/tmp", extra: true })).toThrow(ManagedViewError)
    expect(() => parseRegisterBody({ bindingEpoch: "1", workspacePath: "relative" })).toThrow(ManagedViewError)
    expect(parseCloseBody({ bindingEpoch: "2", mode: "expired" })).toEqual({ bindingEpoch: "2", mode: "expired" })
    expect(() => parseCloseBody({ bindingEpoch: "2", mode: "force" })).toThrow(ManagedViewError)
  })

  test("uses exact loopback addresses and constant-time token equality", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("10.0.0.1")).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(managementTokenMatches("secret", "secret")).toBe(true)
    expect(managementTokenMatches("secret", "other")).toBe(false)
    expect(managementTokenMatches(undefined, "secret")).toBe(false)
  })
})

describe("managed view lifecycle", () => {
  let root: string
  let workspaceA: string
  let workspaceB: string
  let runtime: FakeRuntime
  let manager: ManagedViewManager

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "kk-managed-views-"))
    const directoryA = path.join(root, "a")
    const directoryB = path.join(root, "b")
    await fs.mkdir(directoryA)
    await fs.mkdir(directoryB)
    workspaceA = directoryA
    workspaceB = directoryB
    runtime = new FakeRuntime()
    manager = new ManagedViewManager({ managementToken: "token", resourceExitTimeoutMs: 25 })
  })

  afterEach(async () => {
    manager.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })

  test("register is idempotent for the same binding and rejects rollback", async () => {
    const first = await manager.register(VIEW_A, "2", workspaceA, runtime)
    const second = await manager.register(VIEW_A, "2", workspaceA, runtime)
    expect(first.state).toBe("OPEN")
    expect(second.state).toBe("OPEN")
    expect(runtime.registrations).toEqual([`${VIEW_A}:2`])
    await expect(manager.register(VIEW_A, "1", workspaceA, runtime)).rejects.toMatchObject({
      code: "VIEW_EPOCH_ROLLBACK",
    })
    await expect(manager.register(VIEW_A, "2", workspaceB, runtime)).rejects.toMatchObject({
      code: "VIEW_BINDING_CONFLICT",
    })
  })

  test("a higher epoch rebinds the same view and preserves terminals", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    const http = new FakeResource()
    expect(manager.trackHttp(VIEW_A, "1", http)).toBe(true)

    const rebound = await manager.register(VIEW_A, "2", workspaceA, runtime)
    expect(rebound.bindingEpoch).toBe("2")
    expect(rebound.state).toBe("OPEN")
    expect(rebound.resources.terminals).toEqual([{ id: 7, pid: 1235 }])
    expect(rebound.resources.extensionHosts).toEqual([])
    expect(http.destroyed).toBe(true)
    expect(runtime.rebinds).toEqual([`${VIEW_A}:1->2`])
    expect(manager.isOpen(VIEW_A, "1")).toBe(false)
    expect(manager.isOpen(VIEW_A, "2")).toBe(true)
    await expect(manager.inspect(VIEW_A, "1", runtime)).rejects.toMatchObject({ code: "VIEW_EPOCH_MISMATCH" })
  })

  test("rebind cleanup failure keeps CLEANUP_FAILED and can be retried", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    runtime.failRebind = true
    const http = new FakeResource()
    expect(manager.trackHttp(VIEW_A, "1", http)).toBe(true)

    await expect(manager.register(VIEW_A, "2", workspaceA, runtime)).rejects.toMatchObject({
      code: "REBIND_CLEANUP_FAILED",
    })
    expect((await manager.inspect(VIEW_A, "1", runtime)).state).toBe("CLEANUP_FAILED")

    runtime.failRebind = false
    const retried = await manager.register(VIEW_A, "2", workspaceA, runtime)
    expect(retried.state).toBe("OPEN")
    expect(retried.bindingEpoch).toBe("2")
    expect(manager.isOpen(VIEW_A, "2")).toBe(true)
    expect(runtime.rebinds).toEqual([`${VIEW_A}:1->2`, `${VIEW_A}:1->2`])
  })

  test("a local rebind cleanup failure can be retried after the resource exits", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    const resource = new FakeResource(false)
    expect(manager.trackHttp(VIEW_A, "1", resource)).toBe(true)

    await expect(manager.register(VIEW_A, "2", workspaceA, runtime)).rejects.toMatchObject({
      code: "REBIND_CLEANUP_FAILED",
    })
    expect((await manager.inspect(VIEW_A, "1", runtime)).state).toBe("CLEANUP_FAILED")

    resource.emit("close")
    const retried = await manager.register(VIEW_A, "2", workspaceA, runtime)
    expect(retried.state).toBe("OPEN")
    expect(retried.bindingEpoch).toBe("2")
  })

  test("inspect exposes resource facts and never claims a clean draft state", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    const inspected = await manager.inspect(VIEW_A, "1", runtime)
    expect(inspected.dirty).toBe("unknown")
    expect(inspected.draftBackup.supported).toBe(false)
    expect(inspected.resources.extensionHosts).toEqual([{ id: "extension-1", pid: 1234 }])
    expect(inspected.resources.terminals).toEqual([{ id: 7, pid: 1235 }])
  })

  test("close waits for local close events and keeps the other view alive", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    await manager.register(VIEW_B, "2", workspaceB, runtime)
    const resourceA = new FakeResource()
    const resourceB = new FakeResource()
    expect(manager.trackHttp(VIEW_A, "1", resourceA)).toBe(true)
    expect(manager.trackHttp(VIEW_B, "2", resourceB)).toBe(true)

    const closed = await manager.close(VIEW_A, "1", "discard", runtime)
    expect(closed.cleanup.complete).toBe(true)
    expect(closed.resources.http).toBe(0)
    expect(resourceA.destroyed).toBe(true)
    expect(resourceB.destroyed).toBe(false)
    expect(manager.isOpen(VIEW_B, "2")).toBe(true)
    expect(runtime.closes).toEqual([VIEW_A])
  })

  test("a resource without a close event fails closed and leaves a retryable record", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    const resource = new FakeResource(false)
    expect(manager.trackHttp(VIEW_A, "1", resource)).toBe(true)

    const failed = await manager.close(VIEW_A, "1", "discard", runtime)
    expect(failed.state).toBe("CLEANUP_FAILED")
    expect(failed.cleanup.complete).toBe(false)
    expect(failed.failures.join(" ")).toContain("did not close")
    const failedRecord = await manager.inspect(VIEW_A, "1", runtime)
    expect(failedRecord.state).toBe("CLEANUP_FAILED")

    resource.emit("close")
    const retried = await manager.close(VIEW_A, "1", "expired", runtime)
    expect(retried.state).toBe("CLOSED")
    expect(retried.cleanup.complete).toBe(true)
    expect(manager.hasView(VIEW_A)).toBe(true)
    await expect(manager.inspect(VIEW_A, "1", runtime)).resolves.toMatchObject({ state: "CLOSED" })
  })

  test("runtime cleanup failure is reported and never maps to success", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    runtime.failClose = true
    const failed = await manager.close(VIEW_A, "1", "discard", runtime)
    expect(failed.state).toBe("CLEANUP_FAILED")
    expect(failed.cleanup.complete).toBe(false)
    expect(failed.failures).toContain("extension host did not exit")
    expect(manager.isOpen(VIEW_A, "1")).toBe(false)
  })

  test("close and inspect are idempotent for the same identity", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    const first = await manager.close(VIEW_A, "1", "discard", runtime)
    const second = await manager.close(VIEW_A, "1", "discard", runtime)
    expect(second.cleanup).toEqual(first.cleanup)
    expect(second.state).toBe("CLOSED")
    expect(runtime.closes).toEqual([VIEW_A])
    const inspected = await manager.inspect(VIEW_A, "1", runtime)
    expect(inspected.state).toBe("CLOSED")
  })

  test("normal close is rejected while dirty is unknown", async () => {
    await manager.register(VIEW_A, "1", workspaceA, runtime)
    await expect(manager.close(VIEW_A, "1", "normal", runtime)).rejects.toMatchObject({
      code: "DRAFT_STATE_UNKNOWN",
    })
    expect(runtime.closes).toEqual([])
    expect(manager.isOpen(VIEW_A, "1")).toBe(true)
  })

  test("a closed view cannot be reopened at the same or an older epoch", async () => {
    await manager.register(VIEW_A, "2", workspaceA, runtime)
    await manager.close(VIEW_A, "2", "expired", runtime)
    await expect(manager.register(VIEW_A, "1", workspaceA, runtime)).rejects.toMatchObject({
      code: "VIEW_EPOCH_ROLLBACK",
    })
    const same = await manager.register(VIEW_A, "2", workspaceA, runtime)
    expect(same.state).toBe("CLOSED")
    const next = await manager.register(VIEW_A, "3", workspaceA, runtime)
    expect(next.state).toBe("OPEN")
    expect(next.bindingEpoch).toBe("3")
  })

  test("a fresh manager has no active views", async () => {
    await expect(manager.list(runtime)).resolves.toEqual([])
    expect(manager.hasView(VIEW_A)).toBe(false)
  })

  test("canonicalizes existing workspace directories and workspace files", async () => {
    const workspaceFile = path.join(root, "a.code-workspace")
    await fs.writeFile(workspaceFile, "{}")
    await expect(canonicalWorkspacePath(workspaceA)).resolves.toBe(workspaceA)
    await expect(canonicalWorkspacePath(workspaceFile)).resolves.toBe(workspaceFile)
    await expect(canonicalWorkspacePath(path.join(root, "missing"))).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    })
    const plainFile = path.join(root, "plain.txt")
    await fs.writeFile(plainFile, "x")
    await expect(canonicalWorkspacePath(plainFile)).rejects.toMatchObject({ code: "INVALID_WORKSPACE_PATH" })
  })
})
