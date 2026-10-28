import * as express from "express"
import * as http from "http"
import * as net from "net"
import { ensureAuthenticated, ensureOrigin } from "../http"
import {
  isLoopbackAddress,
  logManagedViewError,
  ManagedViewError,
  ManagedViewManager,
  managementTokenMatches,
  MANAGED_VIEW_PATH,
  MANAGEMENT_TOKEN_ENV as MANAGEMENT_TOKEN_ENV_NAME,
  MANAGEMENT_TOKEN_HEADER,
  normalizeBindingEpoch,
  normalizeViewId,
  parseCloseBody,
  parseInspectEpoch,
  parseRegisterBody,
} from "../managedViews"
import { SocketProxyProvider } from "../socket"
import { type WebsocketRequest, Router as WsRouter } from "../wsRouter"
import { createStaticHandler } from "./static"
import { ensureVSCodeLoaded, getVSCodeServer, manifestHandler, mintKeyHandler } from "./vscode"

interface ManagedViewParams {
  viewId?: string
  bindingEpoch?: string
}

function sendJson(res: express.Response, status: number, body: unknown): void {
  res.status(status).set("Cache-Control", "no-store").json(body)
}

function sendError(res: express.Response, error: ManagedViewError): void {
  sendJson(res, error.status, { error: error.code, message: error.message })
}

function isBodyParserError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return false
  }
  const type = (error as { type?: unknown }).type
  return typeof type === "string" && type.startsWith("entity.")
}

function requireManagementAccess(manager: ManagedViewManager): express.RequestHandler {
  return (req, res, next) => {
    if (!manager.managementEnabled) {
      sendJson(res, 503, {
        error: "MANAGEMENT_DISABLED",
        message: `${MANAGEMENT_TOKEN_ENV_NAME} is not configured`,
      })
      return
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: "LOOPBACK_REQUIRED", message: "management requests are loopback only" })
      return
    }
    const provided = req.get(MANAGEMENT_TOKEN_HEADER)
    if (!managementTokenMatches(provided, manager.managementToken)) {
      sendJson(res, 401, { error: "UNAUTHORIZED", message: "invalid management token" })
      return
    }
    next()
  }
}

export function createManagementRouter(manager: ManagedViewManager): express.Router {
  const router = express.Router()

  router.use(requireManagementAccess(manager))
  router.use(ensureVSCodeLoaded)
  router.use(express.json({ limit: "16kb", strict: true }))

  router.get("/views", async (_req, res, next) => {
    try {
      const runtime = getVSCodeServer()?.managedViews
      if (!runtime) {
        throw new ManagedViewError(503, "MANAGEMENT_UNAVAILABLE", "managed-view runtime is not available")
      }
      sendJson(res, 200, { views: await manager.list(runtime) })
    } catch (error) {
      next(error)
    }
  })

  router.post("/views/:viewId", async (req, res, next) => {
    try {
      const runtime = getVSCodeServer()?.managedViews
      if (!runtime) {
        throw new ManagedViewError(503, "MANAGEMENT_UNAVAILABLE", "managed-view runtime is not available")
      }
      const viewId = normalizeViewId(req.params.viewId)
      const body = parseRegisterBody(req.body)
      sendJson(res, 200, await manager.register(viewId, body.bindingEpoch, body.workspacePath, runtime))
    } catch (error) {
      next(error)
    }
  })

  router.get("/views/:viewId", async (req, res, next) => {
    try {
      const runtime = getVSCodeServer()?.managedViews
      if (!runtime) {
        throw new ManagedViewError(503, "MANAGEMENT_UNAVAILABLE", "managed-view runtime is not available")
      }
      const viewId = normalizeViewId(req.params.viewId)
      const bindingEpoch = parseInspectEpoch(req.query.bindingEpoch)
      sendJson(res, 200, await manager.inspect(viewId, bindingEpoch, runtime))
    } catch (error) {
      next(error)
    }
  })

  router.delete("/views/:viewId", async (req, res, next) => {
    try {
      const runtime = getVSCodeServer()?.managedViews
      if (!runtime) {
        throw new ManagedViewError(503, "MANAGEMENT_UNAVAILABLE", "managed-view runtime is not available")
      }
      const viewId = normalizeViewId(req.params.viewId)
      const body = parseCloseBody(req.body)
      const result = await manager.close(viewId, body.bindingEpoch, body.mode, runtime)
      sendJson(res, result.cleanup.complete ? 200 : 500, result)
    } catch (error) {
      next(error)
    }
  })

  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof ManagedViewError) {
      sendError(res, error)
      return
    }
    if (error instanceof SyntaxError || isBodyParserError(error)) {
      sendJson(res, 400, { error: "INVALID_BODY", message: "request body must be a bounded JSON object" })
      return
    }
    logManagedViewError(error)
    next(error)
  })

  return router
}

function managedViewParams(req: express.Request): { viewId: string; bindingEpoch: string } {
  const params = req.params as ManagedViewParams
  if (params.viewId === undefined) {
    throw new ManagedViewError(404, "VIEW_NOT_FOUND", "viewId is required")
  }
  const viewId = normalizeViewId(params.viewId)
  if (params.bindingEpoch === undefined) {
    throw new ManagedViewError(404, "VIEW_NOT_FOUND", "bindingEpoch is required")
  }
  return { viewId, bindingEpoch: normalizeBindingEpoch(params.bindingEpoch) }
}

function applyManagedViewHeaders(req: http.IncomingMessage, params: { viewId: string; bindingEpoch: string }): void {
  req.headers["x-kk-managed-view"] = "1"
  req.headers["x-kk-view-id"] = params.viewId
  req.headers["x-kk-binding-epoch"] = params.bindingEpoch
}

function redirectTrailingSlash(req: express.Request, res: express.Response): boolean {
  if (req.method !== "GET") {
    return false
  }
  const [pathname, query] = req.originalUrl.split("?", 2)
  const prefix = `${MANAGED_VIEW_PATH}/${req.params.viewId}/${req.params.bindingEpoch}`
  if (pathname !== prefix) {
    return false
  }
  res.redirect(308, `${pathname}/${query === undefined ? "" : `?${query}`}`)
  return true
}

export interface ManagedViewRouters {
  router: express.Router
  wsRouter: express.Router
  dispose(): void
}

/**
 * Browser-facing view routes. The view identity is carried in the URL, never
 * inferred from Referer or cookies. Every HTTP request and WebSocket upgrade is
 * checked against the local OPEN binding before it reaches VS Code.
 */
export function createViewRouters(manager: ManagedViewManager): ManagedViewRouters {
  const router = express.Router({ mergeParams: true })
  const wsRouter = WsRouter({ mergeParams: true })
  const staticHandler = createStaticHandler()
  const socketProxyProvider = new SocketProxyProvider()

  const validate = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    try {
      if (redirectTrailingSlash(req, res)) {
        return
      }
      const params = managedViewParams(req)
      if (!manager.isOpen(params.viewId, params.bindingEpoch)) {
        const state = manager.hasView(params.viewId) ? "VIEW_EPOCH_MISMATCH" : "VIEW_NOT_FOUND"
        throw new ManagedViewError(410, state, "view is not open for this binding epoch")
      }
      if (!manager.trackHttp(params.viewId, params.bindingEpoch, res)) {
        throw new ManagedViewError(410, "VIEW_CLOSING", "view is closing")
      }
      applyManagedViewHeaders(req, params)
      next()
    } catch (error) {
      if (error instanceof ManagedViewError) {
        sendError(res, error)
        return
      }
      next(error)
    }
  }

  router.use(validate)
  router.use("/_static", staticHandler)
  router.get("/manifest.json", ensureAuthenticated, manifestHandler)
  router.post("/mint-key", ensureAuthenticated, mintKeyHandler)
  router.all(/.*/, ensureAuthenticated, ensureVSCodeLoaded, async (req, res) => {
    const server = getVSCodeServer()
    if (!server) {
      throw new ManagedViewError(503, "MANAGEMENT_UNAVAILABLE", "managed-view runtime is not available")
    }
    await server.handleRequest(req, res)
  })

  wsRouter.ws(/.*/, ensureOrigin, ensureAuthenticated, ensureVSCodeLoaded, async (req: WebsocketRequest) => {
    const params = managedViewParams(req)
    if (!manager.isOpen(params.viewId, params.bindingEpoch)) {
      req.ws.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n")
      return
    }
    if (!manager.trackWebSocket(params.viewId, params.bindingEpoch, req.ws)) {
      req.ws.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n")
      return
    }
    applyManagedViewHeaders(req, params)
    const server = getVSCodeServer()
    if (!server) {
      req.ws.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
      return
    }
    const wrappedSocket = await socketProxyProvider.createProxy(req.ws)
    server.handleUpgrade(req, wrappedSocket as net.Socket)
    req.ws.resume()
  })

  return {
    router,
    wsRouter: wsRouter.router,
    dispose: () => socketProxyProvider.stop(),
  }
}
