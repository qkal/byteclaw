import type { BrowserResponse, BrowserRouteHandler, BrowserRouteRegistrar } from "./types.js";

export function createBrowserRouteApp() {
  const getHandlers = new Map<string, BrowserRouteHandler>();
  const postHandlers = new Map<string, BrowserRouteHandler>();
  const deleteHandlers = new Map<string, BrowserRouteHandler>();
  const app: BrowserRouteRegistrar = {
    delete: (path, handler) => void deleteHandlers.set(path, handler),
    get: (path, handler) => void getHandlers.set(path, handler),
    post: (path, handler) => void postHandlers.set(path, handler),
  };
  return { app, deleteHandlers, getHandlers, postHandlers };
}

export function createBrowserRouteResponse() {
  let statusCode = 200;
  let jsonBody: unknown;
  const res: BrowserResponse = {
    json(body) {
      jsonBody = body;
    },
    status(code) {
      statusCode = code;
      return res;
    },
  };
  return {
    get body() {
      return jsonBody;
    },
    res,
    get statusCode() {
      return statusCode;
    },
  };
}
