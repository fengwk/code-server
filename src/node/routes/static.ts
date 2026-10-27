import express from "express"
import { commit, rootPath } from "../constants"

/**
 * Shared handler for code-server's own `_static` tree. Managed views mount the
 * same handler below their view base so PWA assets and the service worker stay
 * inside the view-scoped path.
 */
export const createStaticHandler = (): express.RequestHandler =>
  express.static(rootPath, {
    cacheControl: commit !== "development",
    fallthrough: false,
    setHeaders: (res, filePath) => {
      // The service worker is served from a sub-path on the static route so this
      // is required to allow it to register a higher scope.
      if (filePath.endsWith("/serviceWorker.js")) {
        res.setHeader("Service-Worker-Allowed", "/")
      }
    },
  })
