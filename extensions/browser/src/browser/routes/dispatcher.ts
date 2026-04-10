import { escapeRegExp } from "../../utils.js";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserRoutes } from "./index.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";

interface BrowserDispatchRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
}

interface BrowserDispatchResponse {
  status: number;
  body: unknown;
}

interface RouteEntry {
  method: BrowserDispatchRequest["method"];
  path: string;
  regex: RegExp;
  paramNames: string[];
  handler: (req: BrowserRequest, res: BrowserResponse) => void | Promise<void>;
}

function compileRoute(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const parts = path.split("/").map((part) => {
    if (part.startsWith(":")) {
      const name = part.slice(1);
      paramNames.push(name);
      return "([^/]+)";
    }
    return escapeRegExp(part);
  });
  return { paramNames, regex: new RegExp(`^${parts.join("/")}$`) };
}

function createRegistry() {
  const routes: RouteEntry[] = [];
  const register =
    (method: RouteEntry["method"]) => (path: string, handler: RouteEntry["handler"]) => {
      const { regex, paramNames } = compileRoute(path);
      routes.push({ handler, method, paramNames, path, regex });
    };
  const router: BrowserRouteRegistrar = {
    delete: register("DELETE"),
    get: register("GET"),
    post: register("POST"),
  };
  return { router, routes };
}

function normalizePath(path: string) {
  if (!path) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

export function createBrowserRouteDispatcher(ctx: BrowserRouteContext) {
  const registry = createRegistry();
  registerBrowserRoutes(registry.router, ctx);

  return {
    dispatch: async (req: BrowserDispatchRequest): Promise<BrowserDispatchResponse> => {
      const { method } = req;
      const path = normalizePath(req.path);
      const query = req.query ?? {};
      const { body } = req;
      const { signal } = req;

      const match = registry.routes.find((route) => {
        if (route.method !== method) {
          return false;
        }
        return route.regex.test(path);
      });
      if (!match) {
        return { body: { error: "Not Found" }, status: 404 };
      }

      const exec = match.regex.exec(path);
      const params: Record<string, string> = {};
      if (exec) {
        for (const [idx, name] of match.paramNames.entries()) {
          const value = exec[idx + 1];
          if (typeof value === "string") {
            try {
              params[name] = decodeURIComponent(value);
            } catch {
              return {
                body: { error: `invalid path parameter encoding: ${name}` },
                status: 400,
              };
            }
          }
        }
      }

      let status = 200;
      let payload: unknown = undefined;
      const res: BrowserResponse = {
        json(bodyValue) {
          payload = bodyValue;
        },
        status(code) {
          status = code;
          return res;
        },
      };

      try {
        await match.handler(
          {
            body,
            params,
            query,
            signal,
          },
          res,
        );
      } catch (error) {
        return { body: { error: String(error) }, status: 500 };
      }

      return { body: payload, status };
    },
  };
}

export type { BrowserDispatchRequest, BrowserDispatchResponse };
