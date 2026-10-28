import { promises as fs } from "fs"
import * as http from "http"
import * as path from "path"
import { Browser, BrowserContext, Page } from "playwright"
import { describe, expect, test } from "./baseFixture"

const TOKEN = "e2e-managed-view-token"
const VIEW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const VIEW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

interface ApiResult {
  status: number
  body: any
}

interface ViewPage {
  context: BrowserContext
  page: Page
}

function request(address: string, method: string, pathname: string, body?: unknown): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const request = http.request(
      `${address.replace("localhost", "127.0.0.1")}${pathname}`,
      {
        method,
        headers: {
          "x-kk-studio-management-token": TOKEN,
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": payload.length }),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          resolve({ status: response.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text) })
        })
      },
    )
    request.on("error", reject)
    request.end(payload)
  })
}

async function inspect(address: string, viewId: string, epoch: string): Promise<any> {
  const result = await request(address, "GET", `/__kk/ide/views/${viewId}?bindingEpoch=${epoch}`)
  expect(result.status).toBe(200)
  return result.body
}

async function register(address: string, viewId: string, epoch: string, workspacePath: string): Promise<any> {
  const result = await request(address, "POST", `/__kk/ide/views/${viewId}`, { bindingEpoch: epoch, workspacePath })
  expect(result.status).toBe(200)
  return result.body
}

async function close(address: string, viewId: string, epoch: string, mode = "discard"): Promise<ApiResult> {
  return request(address, "DELETE", `/__kk/ide/views/${viewId}`, { bindingEpoch: epoch, mode })
}

async function openView(
  browser: Browser,
  address: string,
  viewId: string,
  epoch: string,
  workspacePath: string,
): Promise<ViewPage> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${address}/__kk/ide/view/${viewId}/${epoch}/?workspace=${encodeURIComponent(workspacePath)}`, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  })
  await page.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 120000 })
  return { context, page }
}

async function createTerminal(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+P")
  await page.locator(".quick-input-widget input").waitFor({ state: "visible", timeout: 30000 })
  await page.keyboard.type("Terminal: Create New Terminal", { delay: 20 })
  await page.keyboard.press("Enter")
  await page.locator("textarea.xterm-helper-textarea").first().waitFor({ state: "attached", timeout: 60000 })
}

async function focusRestoredTerminal(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+P")
  await page.locator(".quick-input-widget input").waitFor({ state: "visible", timeout: 30000 })
  await page.keyboard.type("Terminal: Focus Terminal", { delay: 20 })
  await page.keyboard.press("Enter")
  await expect.poll(() => page.locator(".xterm").count(), { timeout: 30000 }).toBeGreaterThanOrEqual(1)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  await expect.poll(() => pidAlive(pid), { timeout: 30000 }).toBe(false)
}

async function descendantPids(root: number): Promise<number[]> {
  const descendants = new Set<number>()
  // Walk only the fixture-owned process and children reported by its own threads.
  const visit = async (pid: number): Promise<void> => {
    let threads: string[]
    try {
      threads = await fs.readdir(`/proc/${pid}/task`)
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return
      }
      throw error
    }
    for (const thread of threads) {
      let children: string
      try {
        children = await fs.readFile(`/proc/${pid}/task/${thread}/children`, "utf8")
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          continue
        }
        throw error
      }
      for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
        if (!descendants.has(child)) {
          descendants.add(child)
          await visit(child)
        }
      }
    }
  }
  await visit(root)
  return [...descendants]
}

async function requestHeader(address: string, pathname: string, header: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${address.replace("localhost", "127.0.0.1")}${pathname}`, (response) => {
      response.resume()
      response.on("end", () => {
        const value = response.headers[header]
        resolve(Array.isArray(value) ? value[0] : value)
      })
    })
    req.on("error", reject)
  })
}

describe(
  "managed views",
  ["--disable-workspace-trust", "--auth", "none"],
  { KK_STUDIO_IDE_MANAGEMENT_TOKEN: TOKEN },
  () => {
    test.setTimeout(600000)

    test.afterEach(async ({ codeServer }) => {
      const root = await codeServer.pid()
      const children = await descendantPids(root)
      await codeServer.close()
      await waitForPidExit(root)
      for (const pid of children) {
        await waitForPidExit(pid)
      }
    })

    test("real extension hosts and terminals are isolated per view and close with exit evidence", async ({
      codeServer,
      browser,
    }) => {
      const address = await codeServer.address()
      const serverPid = await codeServer.pid()
      const root = await codeServer.workspaceDir
      const dirA = path.join(root, "view-a")
      const dirB = path.join(root, "view-b")
      await fs.mkdir(dirA, { recursive: true })
      await fs.mkdir(dirB, { recursive: true })
      const workspaceA = path.join(root, "view-a.code-workspace")
      const workspaceB = path.join(root, "view-b.code-workspace")
      await fs.writeFile(workspaceA, JSON.stringify({ folders: [{ path: "view-a" }] }))
      await fs.writeFile(workspaceB, JSON.stringify({ folders: [{ path: "view-b" }] }))
      const draft = path.join(dirA, "draft.txt")
      await fs.writeFile(draft, "original")

      // Missing and wrong tokens must not reach any management operation.
      const missing = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          `${address.replace("localhost", "127.0.0.1")}/__kk/ide/views`,
          { method: "GET" },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on("error", reject)
        req.end()
      })
      expect(missing).toBe(401)
      const wrong = await requestWithToken(address, "GET", "/__kk/ide/views", "wrong-token")
      expect(wrong).toBe(401)

      const empty = await request(address, "GET", "/__kk/ide/views")
      expect(empty.status).toBe(200)
      expect(empty.body.views).toEqual([])

      await register(address, VIEW_A, "1", workspaceA)
      await register(address, VIEW_B, "2", workspaceB)

      const viewA = await openView(browser, address, VIEW_A, "1", workspaceA)
      const viewB = await openView(browser, address, VIEW_B, "2", workspaceB)
      expect(
        await requestHeader(
          address,
          `/__kk/ide/view/${VIEW_A}/1/_static/out/browser/serviceWorker.js`,
          "service-worker-allowed",
        ),
      ).toBe(`/__kk/ide/view/${VIEW_A}/1/`)

      await expect
        .poll(async () => (await inspect(address, VIEW_A, "1")).resources.extensionHosts.length, { timeout: 120000 })
        .toBeGreaterThanOrEqual(1)
      await expect
        .poll(async () => (await inspect(address, VIEW_B, "2")).resources.extensionHosts.length, { timeout: 120000 })
        .toBeGreaterThanOrEqual(1)

      await createTerminal(viewA.page)
      await createTerminal(viewB.page)
      await expect
        .poll(
          async () =>
            (await inspect(address, VIEW_A, "1")).resources.terminals.filter((terminal: any) => terminal.pid).length,
          { timeout: 60000 },
        )
        .toBeGreaterThanOrEqual(1)
      await expect
        .poll(
          async () =>
            (await inspect(address, VIEW_B, "2")).resources.terminals.filter((terminal: any) => terminal.pid).length,
          { timeout: 60000 },
        )
        .toBeGreaterThanOrEqual(1)

      const beforeA = await inspect(address, VIEW_A, "1")
      const beforeB = await inspect(address, VIEW_B, "2")
      expect(beforeA.dirty).toBe("unknown")
      expect(beforeA.draftBackup.supported).toBe(false)
      const aExtensionHostPids = beforeA.resources.extensionHosts.map((resource: any) => resource.pid)
      const aTerminalPids = beforeA.resources.terminals.map((resource: any) => resource.pid)
      const bPids = [...beforeB.resources.extensionHosts, ...beforeB.resources.terminals].map(
        (resource: any) => resource.pid,
      )
      expect(aExtensionHostPids.every((pid: number) => pidAlive(pid))).toBe(true)
      expect(aTerminalPids.every((pid: number) => pidAlive(pid))).toBe(true)
      expect(bPids.every((pid: number) => pidAlive(pid))).toBe(true)

      // A refresh/resume is a rebind of the same view, not close+create. The old
      // extension host and browser scope must exit, while the terminal process
      // and its PTY-host state remain available to the new epoch.
      const rebound = await register(address, VIEW_A, "2", workspaceA)
      expect(rebound.state).toBe("OPEN")
      expect(rebound.bindingEpoch).toBe("2")
      for (const pid of aExtensionHostPids) {
        await waitForPidExit(pid)
      }
      expect(aTerminalPids.every((pid: number) => pidAlive(pid))).toBe(true)

      const reboundFacts = await inspect(address, VIEW_A, "2")
      expect(reboundFacts.resources.extensionHosts).toEqual([])
      expect(reboundFacts.resources.terminals).toEqual(beforeA.resources.terminals)

      const oldScope = await viewA.page.goto(`${address}/__kk/ide/view/${VIEW_A}/1/`, { waitUntil: "domcontentloaded" })
      expect(oldScope?.status()).toBe(410)
      await viewA.context.close()

      const viewA2 = await openView(browser, address, VIEW_A, "2", workspaceA)
      await expect
        .poll(async () => (await inspect(address, VIEW_A, "2")).resources.extensionHosts.length, { timeout: 120000 })
        .toBeGreaterThanOrEqual(1)
      await focusRestoredTerminal(viewA2.page)
      const reboundLiveA = await inspect(address, VIEW_A, "2")
      expect(reboundLiveA.resources.terminals).toEqual(beforeA.resources.terminals)
      expect(reboundLiveA.resources.extensionHosts.every((host: any) => !aExtensionHostPids.includes(host.pid))).toBe(
        true,
      )

      // B is unaffected by A's rebind and keeps its own extension host/terminal.
      const reboundB = await inspect(address, VIEW_B, "2")
      expect(reboundB.state).toBe("OPEN")
      expect(reboundB.resources.extensionHosts.map((resource: any) => resource.pid)).toEqual(
        beforeB.resources.extensionHosts.map((resource: any) => resource.pid),
      )
      expect(reboundB.resources.terminals).toEqual(beforeB.resources.terminals)
      expect(bPids.every((pid: number) => pidAlive(pid))).toBe(true)
      expect(await viewB.page.locator(".monaco-workbench").isVisible()).toBe(true)

      const aPids = [...reboundLiveA.resources.extensionHosts, ...reboundLiveA.resources.terminals].map(
        (resource: any) => resource.pid,
      )
      const closeA = await close(address, VIEW_A, "2")
      expect(closeA.status).toBe(200)
      expect(closeA.body.state).toBe("CLOSED")
      expect(closeA.body.cleanup.complete).toBe(true)
      expect(closeA.body.resources.extensionHosts).toEqual([])
      for (const pid of aPids) {
        await waitForPidExit(pid)
      }

      // B and the shared PTY host survive A's close. The page remains live.
      expect((await inspect(address, VIEW_B, "2")).state).toBe("OPEN")
      expect(bPids.every((pid: number) => pidAlive(pid))).toBe(true)
      expect(await viewB.page.locator(".monaco-workbench").isVisible()).toBe(true)
      expect(await fs.readFile(draft, "utf8")).toBe("original")

      await viewA2.context.close()
      await viewB.context.close()

      const normalB = await close(address, VIEW_B, "2", "normal")
      expect(normalB.status).toBe(409)
      expect(normalB.body.error).toBe("DRAFT_STATE_UNKNOWN")
      expect((await inspect(address, VIEW_B, "2")).state).toBe("OPEN")

      const closeB = await close(address, VIEW_B, "2")
      expect(closeB.status).toBe(200)
      for (const pid of bPids) {
        await waitForPidExit(pid)
      }
      expect((await request(address, "GET", "/__kk/ide/views")).body.views).toEqual([])

      // The code-server process tree returns to a stable shared baseline. Cycles
      // must not accumulate extension hosts or shells beyond the shared pty host.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(pidAlive(serverPid)).toBe(true)
      const baseline = await descendantPids(serverPid)
      for (let cycle = 0; cycle < 3; cycle++) {
        const epoch = String(10 + cycle)
        await register(address, VIEW_A, epoch, workspaceA)
        const page = await openView(browser, address, VIEW_A, epoch, workspaceA)
        await expect
          .poll(async () => (await inspect(address, VIEW_A, epoch)).resources.extensionHosts.length, {
            timeout: 120000,
          })
          .toBeGreaterThanOrEqual(1)
        await createTerminal(page.page)
        await expect
          .poll(
            async () =>
              (await inspect(address, VIEW_A, epoch)).resources.terminals.filter((terminal: any) => terminal.pid)
                .length,
            { timeout: 60000 },
          )
          .toBeGreaterThanOrEqual(1)
        const cycleFacts = await inspect(address, VIEW_A, epoch)
        const pids = [...cycleFacts.resources.extensionHosts, ...cycleFacts.resources.terminals].map(
          (resource: any) => resource.pid,
        )
        expect(pids.every((pid: number) => pidAlive(pid))).toBe(true)
        const closed = await close(address, VIEW_A, epoch, "expired")
        expect(closed.status).toBe(200)
        expect(closed.body.cleanup.complete).toBe(true)
        for (const pid of pids) {
          await waitForPidExit(pid)
        }
        await page.context.close()
        expect((await request(address, "GET", "/__kk/ide/views")).body.views).toEqual([])
      }

      // Closing while a shell is still starting must wait for that launch and
      // leave no untracked process behind.
      const raceEpoch = "20"
      await register(address, VIEW_A, raceEpoch, workspaceA)
      const racePage = await openView(browser, address, VIEW_A, raceEpoch, workspaceA)
      const terminalAttempt = createTerminal(racePage.page).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const raced = await close(address, VIEW_A, raceEpoch, "expired")
      expect(raced.status).toBe(200)
      expect(raced.body.state).toBe("CLOSED")
      expect(raced.body.cleanup.complete).toBe(true)
      await Promise.race([terminalAttempt, new Promise((resolve) => setTimeout(resolve, 5000))])
      await racePage.context.close()
      expect((await request(address, "GET", "/__kk/ide/views")).body.views).toEqual([])

      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(pidAlive(serverPid)).toBe(true)
      const final = await descendantPids(serverPid)
      expect(final.length).toBeLessThanOrEqual(baseline.length + 1)
    })
  },
)

function requestWithToken(address: string, method: string, pathname: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${address.replace("localhost", "127.0.0.1")}${pathname}`,
      { method, headers: { "x-kk-studio-management-token": token } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    req.end()
  })
}
