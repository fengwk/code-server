import { logger } from "@coder/logger"
import * as crypto from "crypto"
import { promises as fs } from "fs"
import * as path from "path"

/**
 * Local management contract for code-server views.
 *
 * The daemon adapter registers a view before sending browser traffic to it.
 * View-scoped traffic is addressed as
 * `/__kk/ide/view/<viewId>/<bindingEpoch>/...`; this module owns the local
 * registry, the binding checks enforced by the router, and the lifecycle of the
 * HTTP/WebSocket connections code-server itself accepts.
 *
 * Resource handles owned by VS Code (extension hosts, terminals and management
 * connections) are delegated to the managed-view runtime exposed by the embedded
 * VS Code server. Both halves must confirm actual exit before a close succeeds.
 */

export const MANAGEMENT_TOKEN_ENV = "KK_STUDIO_IDE_MANAGEMENT_TOKEN"
export const MANAGEMENT_TOKEN_HEADER = "x-kk-studio-management-token"
export const MANAGED_VIEW_PATH = "/__kk/ide/view"
export const LONG_MAX = BigInt("9223372036854775807")

/** A per-launch close budget. A timeout is reported as failure, never as exit evidence. */
export const DEFAULT_RESOURCE_EXIT_TIMEOUT_MS = 15_000

const VIEW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EPOCH_RE = /^[1-9][0-9]*$/
const DRAFT_BACKUP_REASON =
  "code-server cannot observe renderer-only unsaved buffers; dirty is reported as unknown and close never claims the workspace is clean"

export type ManagedViewState = "OPEN" | "CLOSING" | "CLEANUP_FAILED"
export type ManagedViewPublicState = ManagedViewState | "CLOSED"
export type ManagedViewMode = "normal" | "discard" | "expired"

export interface ManagedViewResourceFact {
  id: string | number
  pid?: number
}

export interface ManagedViewRuntimeInspection {
  viewId: string
  bindingEpoch: string
  workspacePath: string
  state: ManagedViewPublicState
  dirty: "unknown"
  draftBackup: {
    supported: false
    reason: string
  }
  managementConnections: ManagedViewResourceFact[]
  extensionHosts: ManagedViewResourceFact[]
  terminals: Array<{ id: number; pid?: number }>
  failures: string[]
}

export interface ManagedViewRuntimeRegistration {
  viewId: string
  bindingEpoch: string
  workspacePath: string
  state: ManagedViewPublicState
  created: boolean
}

export interface ManagedViewRuntimeRebind {
  state: "OPEN" | "CLEANUP_FAILED"
  failures: string[]
  releasedManagementConnections: number
  releasedExtensionHosts: number
  preservedTerminals: number
}

export interface ManagedViewRuntimeClose {
  state: "CLOSED" | "CLEANUP_FAILED"
  failures: string[]
  releasedManagementConnections: number
  releasedExtensionHosts: number
  releasedTerminals: number
}

/**
 * Implemented by the embedded VS Code server. It is intentionally narrow so the
 * daemon contract does not depend on VS Code internals.
 */
export interface ManagedViewRuntime {
  registerView(viewId: string, bindingEpoch: string, workspacePath: string): Promise<ManagedViewRuntimeRegistration>
  rebindView(
    viewId: string,
    fromBindingEpoch: string,
    bindingEpoch: string,
    workspacePath: string,
  ): Promise<ManagedViewRuntimeRebind>
  inspectView(viewId: string, bindingEpoch: string): Promise<ManagedViewRuntimeInspection>
  closeView(viewId: string, bindingEpoch: string, mode: ManagedViewMode): Promise<ManagedViewRuntimeClose>
  listViews(): Promise<ManagedViewRuntimeInspection[]>
}

export interface ManagedViewInspection {
  viewId: string
  bindingEpoch: string
  workspacePath: string
  state: ManagedViewPublicState
  createdAt: string
  updatedAt: string
  dirty: "unknown"
  draftBackup: {
    supported: false
    reason: string
  }
  resources: {
    http: number
    websockets: number
    managementConnections: ManagedViewResourceFact[]
    extensionHosts: ManagedViewResourceFact[]
    terminals: Array<{ id: number; pid?: number }>
  }
  failures: string[]
}

export interface ManagedViewCloseResult extends ManagedViewInspection {
  mode: ManagedViewMode
  cleanup: {
    complete: boolean
    httpReleased: number
    websocketsReleased: number
    managementConnectionsReleased: number
    extensionHostsReleased: number
    terminalsReleased: number
  }
}

export interface ManagedViewManagerOptions {
  managementToken?: string
  resourceExitTimeoutMs?: number
  closedViewLimit?: number
}

export class ManagedViewError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ManagedViewError"
  }
}

interface TrackedResource {
  close: Promise<void>
  terminate(): void
}

interface ActiveView {
  viewId: string
  bindingEpoch: string
  workspacePath: string
  state: ManagedViewState
  createdAt: string
  updatedAt: string
  http: Set<TrackedResource>
  websockets: Set<TrackedResource>
  failures: string[]
  closePromise?: Promise<ManagedViewCloseResult>
}

interface ClosedView {
  inspection: ManagedViewInspection
  result: ManagedViewCloseResult
}

interface RuntimeFacts {
  managementConnections: ManagedViewResourceFact[]
  extensionHosts: ManagedViewResourceFact[]
  terminals: Array<{ id: number; pid?: number }>
  failures: string[]
}

/** True for the exact loopback addresses a local daemon can use. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

/** Constant-time comparison; missing values never match. */
export function managementTokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (provided === undefined || expected === undefined || expected.length === 0) {
    return false
  }
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function normalizeViewId(value: unknown): string {
  if (typeof value !== "string" || !VIEW_ID_RE.test(value)) {
    throw new ManagedViewError(400, "INVALID_VIEW_ID", "viewId must be a canonical lowercase UUID")
  }
  return value
}

export function normalizeBindingEpoch(value: unknown): string {
  if (typeof value !== "string" || !EPOCH_RE.test(value)) {
    throw new ManagedViewError(400, "INVALID_BINDING_EPOCH", "bindingEpoch must be a positive decimal string")
  }
  const epoch = BigInt(value)
  if (epoch > LONG_MAX) {
    throw new ManagedViewError(400, "INVALID_BINDING_EPOCH", "bindingEpoch is out of range")
  }
  return value
}

function requireObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ManagedViewError(400, "INVALID_BODY", "request body must be a JSON object")
  }
  return body as Record<string, unknown>
}

function requireExactKeys(body: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(body).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ManagedViewError(400, "INVALID_BODY", `request body must contain exactly ${expected.join(", ")}`)
  }
}

export function parseRegisterBody(body: unknown): { bindingEpoch: string; workspacePath: string } {
  const object = requireObject(body)
  requireExactKeys(object, ["bindingEpoch", "workspacePath"])
  const bindingEpoch = normalizeBindingEpoch(object.bindingEpoch)
  if (
    typeof object.workspacePath !== "string" ||
    object.workspacePath.length === 0 ||
    object.workspacePath.length > 4096
  ) {
    throw new ManagedViewError(400, "INVALID_WORKSPACE_PATH", "workspacePath must be a non-empty absolute path")
  }
  if (!path.isAbsolute(object.workspacePath) || object.workspacePath.includes("\0")) {
    throw new ManagedViewError(400, "INVALID_WORKSPACE_PATH", "workspacePath must be an absolute path")
  }
  return { bindingEpoch, workspacePath: object.workspacePath }
}

export function parseCloseBody(body: unknown): { bindingEpoch: string; mode: ManagedViewMode } {
  const object = requireObject(body)
  requireExactKeys(object, ["bindingEpoch", "mode"])
  const bindingEpoch = normalizeBindingEpoch(object.bindingEpoch)
  if (object.mode !== "normal" && object.mode !== "discard" && object.mode !== "expired") {
    throw new ManagedViewError(400, "INVALID_MODE", "mode must be normal, discard or expired")
  }
  return { bindingEpoch, mode: object.mode }
}

export function parseInspectEpoch(value: unknown): string {
  if (typeof value !== "string") {
    throw new ManagedViewError(400, "INVALID_BINDING_EPOCH", "bindingEpoch query parameter is required")
  }
  return normalizeBindingEpoch(value)
}

/** Resolve the workspace once at registration so later requests cannot drift. */
export async function canonicalWorkspacePath(value: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new ManagedViewError(400, "INVALID_WORKSPACE_PATH", "workspacePath must be an absolute path")
  }
  let resolved: string
  try {
    resolved = await fs.realpath(value)
  } catch {
    throw new ManagedViewError(400, "WORKSPACE_NOT_FOUND", "workspacePath does not exist")
  }
  let stat
  try {
    stat = await fs.stat(resolved)
  } catch {
    throw new ManagedViewError(400, "WORKSPACE_NOT_FOUND", "workspacePath does not exist")
  }
  if (stat.isDirectory()) {
    return resolved
  }
  if (stat.isFile() && path.extname(resolved) === ".code-workspace") {
    return resolved
  }
  throw new ManagedViewError(
    400,
    "INVALID_WORKSPACE_PATH",
    "workspacePath must be a directory or a .code-workspace file",
  )
}

function draftBackup() {
  return { supported: false as const, reason: DRAFT_BACKUP_REASON }
}

function emptyRuntimeFacts(): RuntimeFacts {
  return { managementConnections: [], extensionHosts: [], terminals: [], failures: [] }
}

function resourceExitTimeout(timeoutMs: number): Error {
  const error = new Error("managed resource did not report exit before the cleanup budget")
  error.name = "ResourceExitTimeout"
  return error
}

function waitForTrackedResource(resource: TrackedResource, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(resourceExitTimeout(timeoutMs)), timeoutMs)
    timer.unref()
    resource.close.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
    try {
      resource.terminate()
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}

/** Build one tracked HTTP resource; close event is the only success signal. */
export function trackHttpResponse(res: {
  once(event: "close", listener: () => void): unknown
  destroy(): void
}): TrackedResource {
  const close = new Promise<void>((resolve) => res.once("close", resolve))
  return { close, terminate: () => res.destroy() }
}

/** Build one tracked WebSocket resource; close event is the only success signal. */
export function trackWebSocket(socket: {
  once(event: "close", listener: () => void): unknown
  destroy(): void
}): TrackedResource {
  const close = new Promise<void>((resolve) => socket.once("close", resolve))
  return { close, terminate: () => socket.destroy() }
}

export class ManagedViewManager {
  private readonly token: string | undefined
  private readonly resourceExitTimeoutMs: number
  private readonly closedViewLimit: number
  private readonly active = new Map<string, ActiveView>()
  private readonly closed = new Map<string, ClosedView>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private disposed = false

  constructor(options: ManagedViewManagerOptions = {}) {
    this.token = options.managementToken ?? process.env[MANAGEMENT_TOKEN_ENV]
    this.resourceExitTimeoutMs = options.resourceExitTimeoutMs ?? DEFAULT_RESOURCE_EXIT_TIMEOUT_MS
    this.closedViewLimit = options.closedViewLimit ?? 256
  }

  get managementEnabled(): boolean {
    return this.token !== undefined && this.token.length > 0
  }

  get managementToken(): string | undefined {
    return this.token
  }

  dispose(): void {
    this.disposed = true
    for (const view of this.active.values()) {
      for (const resource of view.http) {
        resource.terminate()
      }
      for (const resource of view.websockets) {
        resource.terminate()
      }
    }
  }

  isOpen(viewId: string, bindingEpoch: string): boolean {
    const view = this.active.get(viewId)
    return view !== undefined && view.state === "OPEN" && view.bindingEpoch === bindingEpoch
  }

  hasView(viewId: string): boolean {
    return this.active.has(viewId) || this.closed.has(viewId)
  }

  trackHttp(
    viewId: string,
    bindingEpoch: string,
    res: {
      once(event: "close", listener: () => void): unknown
      destroy(): void
    },
  ): boolean {
    return this.track(viewId, bindingEpoch, "http", res)
  }

  trackWebSocket(
    viewId: string,
    bindingEpoch: string,
    socket: {
      once(event: "close", listener: () => void): unknown
      destroy(): void
    },
  ): boolean {
    return this.track(viewId, bindingEpoch, "websockets", socket)
  }

  private track(
    viewId: string,
    bindingEpoch: string,
    bucket: "http" | "websockets",
    source: { once(event: "close", listener: () => void): unknown; destroy(): void },
  ): boolean {
    const view = this.active.get(viewId)
    if (!view || view.state !== "OPEN" || view.bindingEpoch !== bindingEpoch) {
      return false
    }
    const resource = trackHttpResponse(source)
    view[bucket].add(resource)
    void resource.close.then(() => view[bucket].delete(resource))
    return true
  }

  register(
    viewIdInput: unknown,
    bindingEpochInput: unknown,
    workspacePathInput: unknown,
    runtime: ManagedViewRuntime,
  ): Promise<ManagedViewInspection> {
    const viewId = normalizeViewId(viewIdInput)
    const bindingEpoch = normalizeBindingEpoch(bindingEpochInput)
    if (typeof workspacePathInput !== "string") {
      throw new ManagedViewError(400, "INVALID_WORKSPACE_PATH", "workspacePath must be a string")
    }
    return this.withLock(viewId, async () => {
      const existing = this.active.get(viewId)
      if (existing) {
        const workspacePath = await canonicalWorkspacePath(workspacePathInput)
        if (existing.workspacePath !== workspacePath) {
          throw new ManagedViewError(409, "VIEW_BINDING_CONFLICT", "view is bound to a different workspace")
        }
        if (existing.bindingEpoch === bindingEpoch) {
          return this.inspectActive(existing, runtime)
        }
        if (BigInt(bindingEpoch) < BigInt(existing.bindingEpoch)) {
          throw new ManagedViewError(409, "VIEW_EPOCH_ROLLBACK", "bindingEpoch cannot move backwards")
        }
        // A failed rebind keeps the old epoch and remaining handles. Retrying
        // with a higher epoch converges that cleanup instead of leaking the
        // view or pretending the new binding already exists.
        return this.rebind(existing, bindingEpoch, runtime)
      }
      const closed = this.closed.get(viewId)
      let replacesClosed = false
      if (closed) {
        if (closed.inspection.bindingEpoch === bindingEpoch) {
          if (closed.inspection.workspacePath !== (await canonicalWorkspacePath(workspacePathInput))) {
            throw new ManagedViewError(409, "VIEW_BINDING_CONFLICT", "closed view used a different workspace")
          }
          return closed.inspection
        }
        if (BigInt(bindingEpoch) < BigInt(closed.inspection.bindingEpoch)) {
          throw new ManagedViewError(409, "VIEW_EPOCH_ROLLBACK", "bindingEpoch cannot move backwards")
        }
        // A higher epoch after a completed close starts a fresh local record.
        // Keep the tombstone until the runtime accepts the new binding so a
        // failed registration does not erase the last completed close.
        replacesClosed = true
      }
      const workspacePath = await canonicalWorkspacePath(workspacePathInput)
      const registration = await runtime.registerView(viewId, bindingEpoch, workspacePath)
      if (registration.state === "CLOSED") {
        throw new ManagedViewError(409, "VIEW_CLOSED", "runtime reports the view as closed")
      }
      if (replacesClosed) {
        this.closed.delete(viewId)
      }
      const now = new Date().toISOString()
      const view: ActiveView = {
        viewId,
        bindingEpoch,
        workspacePath,
        state: registration.state === "CLEANUP_FAILED" ? "CLEANUP_FAILED" : "OPEN",
        createdAt: now,
        updatedAt: now,
        http: new Set(),
        websockets: new Set(),
        failures: [],
      }
      this.active.set(viewId, view)
      return this.inspectActive(view, runtime)
    })
  }

  private async rebind(
    view: ActiveView,
    bindingEpoch: string,
    runtime: ManagedViewRuntime,
  ): Promise<ManagedViewInspection> {
    view.state = "CLOSING"
    view.updatedAt = new Date().toISOString()
    const http = [...view.http]
    const websockets = [...view.websockets]
    const local = await Promise.allSettled([
      ...http.map((resource) => waitForTrackedResource(resource, this.resourceExitTimeoutMs)),
      ...websockets.map((resource) => waitForTrackedResource(resource, this.resourceExitTimeoutMs)),
    ])
    const failures: string[] = []
    local.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        failures.push(
          `local ${index < http.length ? "http" : "websocket"} resource did not close: ${
            outcome.reason instanceof Error ? outcome.reason.message : "unknown error"
          }`,
        )
      }
    })
    if (failures.length > 0) {
      view.state = "CLEANUP_FAILED"
      view.failures = failures
      throw new ManagedViewError(500, "REBIND_CLEANUP_FAILED", failures.join("; "))
    }

    let runtimeResult: ManagedViewRuntimeRebind
    try {
      runtimeResult = await runtime.rebindView(view.viewId, view.bindingEpoch, bindingEpoch, view.workspacePath)
    } catch (error) {
      runtimeResult = {
        state: "CLEANUP_FAILED",
        failures: [`runtime rebind failed: ${error instanceof Error ? error.message : "unknown error"}`],
        releasedManagementConnections: 0,
        releasedExtensionHosts: 0,
        preservedTerminals: 0,
      }
    }
    failures.push(...runtimeResult.failures)
    if (runtimeResult.state !== "OPEN" || failures.length > 0) {
      view.state = "CLEANUP_FAILED"
      view.failures = failures
      view.updatedAt = new Date().toISOString()
      throw new ManagedViewError(500, "REBIND_CLEANUP_FAILED", failures.join("; ") || "runtime did not complete rebind")
    }

    view.bindingEpoch = bindingEpoch
    view.state = "OPEN"
    view.failures = []
    view.updatedAt = new Date().toISOString()
    return this.inspectActive(view, runtime)
  }

  inspect(
    viewIdInput: unknown,
    bindingEpochInput: unknown,
    runtime: ManagedViewRuntime,
  ): Promise<ManagedViewInspection> {
    const viewId = normalizeViewId(viewIdInput)
    const bindingEpoch = normalizeBindingEpoch(bindingEpochInput)
    return this.withLock(viewId, async () => {
      const view = this.active.get(viewId)
      if (view) {
        if (view.bindingEpoch !== bindingEpoch) {
          throw new ManagedViewError(409, "VIEW_EPOCH_MISMATCH", "view is bound to a different epoch")
        }
        return this.inspectActive(view, runtime)
      }
      const closed = this.closed.get(viewId)
      if (closed) {
        if (closed.inspection.bindingEpoch !== bindingEpoch) {
          throw new ManagedViewError(409, "VIEW_EPOCH_MISMATCH", "view was last closed at a different epoch")
        }
        return closed.inspection
      }
      throw new ManagedViewError(404, "VIEW_NOT_FOUND", "view is not registered")
    })
  }

  close(
    viewIdInput: unknown,
    bindingEpochInput: unknown,
    mode: ManagedViewMode,
    runtime: ManagedViewRuntime,
  ): Promise<ManagedViewCloseResult> {
    const viewId = normalizeViewId(viewIdInput)
    const bindingEpoch = normalizeBindingEpoch(bindingEpochInput)
    return this.withLock(viewId, async () => {
      if (mode === "normal") {
        throw new ManagedViewError(
          409,
          "DRAFT_STATE_UNKNOWN",
          "dirty state is unknown; use discard or expired after the caller has backed up drafts",
        )
      }
      const closed = this.closed.get(viewId)
      if (closed) {
        if (closed.inspection.bindingEpoch !== bindingEpoch) {
          throw new ManagedViewError(409, "VIEW_EPOCH_MISMATCH", "view was last closed at a different epoch")
        }
        return { ...closed.result, mode }
      }
      const view = this.active.get(viewId)
      if (!view) {
        throw new ManagedViewError(404, "VIEW_NOT_FOUND", "view is not registered")
      }
      if (view.bindingEpoch !== bindingEpoch) {
        throw new ManagedViewError(409, "VIEW_EPOCH_MISMATCH", "view is bound to a different epoch")
      }
      if (!view.closePromise) {
        view.state = "CLOSING"
        view.updatedAt = new Date().toISOString()
        view.closePromise = this.performClose(view, mode, runtime).finally(() => {
          if (this.active.get(viewId) === view) {
            view.closePromise = undefined
          }
        })
      }
      return view.closePromise
    })
  }

  async list(runtime: ManagedViewRuntime): Promise<ManagedViewInspection[]> {
    const runtimeViews = await runtime.listViews()
    if (this.disposed) {
      return []
    }
    const result: ManagedViewInspection[] = []
    for (const view of this.active.values()) {
      const matching = runtimeViews.find(
        (candidate) => candidate.viewId === view.viewId && candidate.bindingEpoch === view.bindingEpoch,
      )
      const facts = matching
        ? {
            managementConnections: matching.managementConnections,
            extensionHosts: matching.extensionHosts,
            terminals: matching.terminals,
            failures: matching.failures,
          }
        : {
            ...emptyRuntimeFacts(),
            failures: ["runtime does not report this local registration"],
          }
      result.push(this.inspection(view, facts))
    }
    return result
  }

  private async inspectActive(view: ActiveView, runtime: ManagedViewRuntime): Promise<ManagedViewInspection> {
    let facts: RuntimeFacts
    try {
      const inspection = await runtime.inspectView(view.viewId, view.bindingEpoch)
      facts = {
        managementConnections: inspection.managementConnections,
        extensionHosts: inspection.extensionHosts,
        terminals: inspection.terminals,
        failures: inspection.failures,
      }
    } catch (error) {
      facts = {
        ...emptyRuntimeFacts(),
        failures: [`runtime inspection failed: ${error instanceof Error ? error.message : "unknown error"}`],
      }
    }
    return this.inspection(view, facts)
  }

  private inspection(view: ActiveView, facts: RuntimeFacts): ManagedViewInspection {
    return {
      viewId: view.viewId,
      bindingEpoch: view.bindingEpoch,
      workspacePath: view.workspacePath,
      state: view.state,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      dirty: "unknown",
      draftBackup: draftBackup(),
      resources: {
        http: view.http.size,
        websockets: view.websockets.size,
        managementConnections: facts.managementConnections,
        extensionHosts: facts.extensionHosts,
        terminals: facts.terminals,
      },
      failures: [...view.failures, ...facts.failures],
    }
  }

  private async performClose(
    view: ActiveView,
    mode: ManagedViewMode,
    runtime: ManagedViewRuntime,
  ): Promise<ManagedViewCloseResult> {
    const localHttp = [...view.http]
    const localWebSockets = [...view.websockets]
    const local = await Promise.allSettled([
      ...localHttp.map((resource) => waitForTrackedResource(resource, this.resourceExitTimeoutMs)),
      ...localWebSockets.map((resource) => waitForTrackedResource(resource, this.resourceExitTimeoutMs)),
    ])
    const failures: string[] = []
    let httpReleased = 0
    let websocketsReleased = 0
    local.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        if (index < localHttp.length) {
          httpReleased++
        } else {
          websocketsReleased++
        }
      } else {
        failures.push(
          `local ${index < localHttp.length ? "http" : "websocket"} resource did not close: ${
            outcome.reason instanceof Error ? outcome.reason.message : "unknown error"
          }`,
        )
      }
    })

    let runtimeResult: ManagedViewRuntimeClose
    try {
      runtimeResult = await runtime.closeView(view.viewId, view.bindingEpoch, mode)
    } catch (error) {
      runtimeResult = {
        state: "CLEANUP_FAILED",
        failures: [`runtime cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`],
        releasedManagementConnections: 0,
        releasedExtensionHosts: 0,
        releasedTerminals: 0,
      }
    }
    failures.push(...runtimeResult.failures)
    view.failures = [...failures]
    view.updatedAt = new Date().toISOString()

    const complete = failures.length === 0 && runtimeResult.state === "CLOSED"
    if (!complete) {
      view.state = "CLEANUP_FAILED"
      const failed = this.closeResult(
        view,
        mode,
        {
          complete: false,
          httpReleased,
          websocketsReleased,
          managementConnectionsReleased: runtimeResult.releasedManagementConnections,
          extensionHostsReleased: runtimeResult.releasedExtensionHosts,
          terminalsReleased: runtimeResult.releasedTerminals,
        },
        failures,
      )
      return failed
    }

    view.state = "OPEN"
    const inspection = this.inspection(view, emptyRuntimeFacts())
    inspection.state = "CLOSED"
    inspection.resources = {
      http: 0,
      websockets: 0,
      managementConnections: [],
      extensionHosts: [],
      terminals: [],
    }
    inspection.failures = []
    const result: ManagedViewCloseResult = {
      ...inspection,
      mode,
      cleanup: {
        complete: true,
        httpReleased,
        websocketsReleased,
        managementConnectionsReleased: runtimeResult.releasedManagementConnections,
        extensionHostsReleased: runtimeResult.releasedExtensionHosts,
        terminalsReleased: runtimeResult.releasedTerminals,
      },
    }
    this.active.delete(view.viewId)
    this.rememberClosed(view.viewId, inspection, result)
    return result
  }

  private closeResult(
    view: ActiveView,
    mode: ManagedViewMode,
    cleanup: ManagedViewCloseResult["cleanup"],
    failures: string[],
  ): ManagedViewCloseResult {
    const inspection = this.inspection(view, emptyRuntimeFacts())
    inspection.failures = [...failures]
    return { ...inspection, mode, cleanup }
  }

  private rememberClosed(viewId: string, inspection: ManagedViewInspection, result: ManagedViewCloseResult): void {
    this.closed.set(viewId, { inspection, result })
    while (this.closed.size > this.closedViewLimit) {
      const oldest = this.closed.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.closed.delete(oldest)
    }
  }

  private withLock<T>(viewId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(viewId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.locks.set(
      viewId,
      next.catch(() => undefined),
    )
    return next
  }
}

/** Emit one bounded diagnostic line without request bodies, headers or tokens. */
export function logManagedViewError(error: unknown): void {
  const message =
    error instanceof ManagedViewError ? `${error.code}: ${error.message}` : "unexpected management failure"
  logger.warn(`managed views: ${message}`)
}
