import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { AuthorizedGatewayHttpRequest } from "../http-utils.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

function createRoute(params: {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
  gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}) {
  return {
    auth: params.auth,
    gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
    handler: params.handler ?? (() => true),
    match: params.match ?? "exact",
    path: params.path,
    pluginId: "route",
    source: "route",
  };
}

function createMockLogger(): SubsystemLogger {
  const child = vi.fn<(name: string) => SubsystemLogger>();
  const logger = {
    child,
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    isEnabled: () => true,
    raw: vi.fn(),
    subsystem: "test/plugins-http-runtime-scopes",
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies SubsystemLogger;
  child.mockImplementation(() => logger);
  return logger as SubsystemLogger;
}

function assertWriteHelperAllowed() {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
  const auth = authorizeOperatorScopesForMethod("agent", scopes);
  if (!auth.allowed) {
    throw new Error(`missing scope: ${auth.missingScope}`);
  }
}

function assertAdminHelperAllowed() {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
  const auth = authorizeOperatorScopesForMethod("set-heartbeats", scopes);
  if (!auth.allowed) {
    throw new Error(`missing scope: ${auth.missingScope}`);
  }
}

describe("plugin HTTP route runtime scopes", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function invokeRoute(params: {
    path: string;
    auth: "gateway" | "plugin";
    gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
    gatewayAuthSatisfied: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  }) {
    const log = createMockLogger();
    const handler = createGatewayPluginRequestHandler({
      log,
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({
            auth: params.auth,
            gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
            handler: async () => {
              assertWriteHelperAllowed();
              return true;
            },
            path: params.path,
          }),
        ],
      }),
    });

    const response = makeMockHttpResponse();
    const handled = await handler(
      { url: params.path } as IncomingMessage,
      response.res,
      undefined,
      {
        gatewayAuthSatisfied: params.gatewayAuthSatisfied,
        gatewayRequestAuth: params.gatewayRequestAuth,
        gatewayRequestOperatorScopes: params.gatewayRequestOperatorScopes,
      },
    );
    return { handled, log, ...response };
  }

  it("keeps plugin-auth routes off write-capable runtime helpers", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      auth: "plugin",
      gatewayAuthSatisfied: false,
      path: "/hook",
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("missing scope: operator.write"));
  });

  it("preserves write-capable runtime helpers on gateway-auth routes", async () => {
    const { handled, res, log } = await invokeRoute({
      auth: "gateway",
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.write"],
      path: "/secure-hook",
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("fails closed when gateway-auth route runtime scopes are missing", async () => {
    const { handled, res, log } = await invokeRoute({
      auth: "gateway",
      gatewayAuthSatisfied: true,
      path: "/secure-hook",
    });

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("blocked without caller scope context"),
    );
  });

  it("does not allow write helpers for read-scoped gateway-auth requests", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      auth: "gateway",
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.read"],
      path: "/secure-hook",
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("missing scope: operator.write"));
  });

  it("restores trusted-operator defaults for routes opting into trusted surface", async () => {
    let observedScopes: string[] | undefined;
    const log = createMockLogger();
    const handler = createGatewayPluginRequestHandler({
      log,
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({
            auth: "gateway",
            gatewayRuntimeScopeSurface: "trusted-operator",
            handler: async () => {
              observedScopes =
                getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
              assertAdminHelperAllowed();
              return true;
            },
            path: "/secure-admin-hook",
          }),
        ],
      }),
    });

    const response = makeMockHttpResponse();
    const handled = await handler(
      { url: "/secure-admin-hook" } as IncomingMessage,
      response.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
    expect(observedScopes).toEqual(
      expect.arrayContaining(["operator.admin", "operator.read", "operator.write"]),
    );
  });

  it("scopes runtime privileges per matched route for exact/prefix overlap", async () => {
    const observed: { route: "exact" | "prefix"; scopes: string[] }[] = [];
    const log = createMockLogger();
    const handler = createGatewayPluginRequestHandler({
      log,
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({
            auth: "gateway",
            handler: async () => {
              observed.push({
                route: "exact",
                scopes:
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
              });
              return false;
            },
            match: "exact",
            path: "/secure/admin-hook",
          }),
          createRoute({
            auth: "gateway",
            gatewayRuntimeScopeSurface: "trusted-operator",
            handler: async () => {
              observed.push({
                route: "prefix",
                scopes:
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
              });
              assertAdminHelperAllowed();
              return true;
            },
            match: "prefix",
            path: "/secure",
          }),
        ],
      }),
    });

    const response = makeMockHttpResponse();
    const handled = await handler(
      { url: "/secure/admin-hook" } as IncomingMessage,
      response.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({
      route: "exact",
      scopes: ["operator.write"],
    });
    expect(observed[1]?.route).toBe("prefix");
    expect(observed[1]?.scopes).toEqual(
      expect.arrayContaining(["operator.admin", "operator.read", "operator.write"]),
    );
  });

  it.each([
    {
      auth: "plugin" as const,
      expectedScopes: [],
      gatewayAuthSatisfied: false,
      gatewayRequestOperatorScopes: undefined,
      path: "/hook",
    },
    {
      auth: "gateway" as const,
      expectedScopes: ["operator.read"],
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.read"],
      path: "/secure-hook",
    },
  ])(
    "maps $auth routes to $expectedScopes",
    async ({ auth, gatewayAuthSatisfied, gatewayRequestOperatorScopes, path, expectedScopes }) => {
      let observedScopes: string[] | undefined;
      const handler = createGatewayPluginRequestHandler({
        log: createMockLogger(),
        registry: createTestRegistry({
          httpRoutes: [
            createRoute({
              auth,
              handler: vi.fn(async () => {
                observedScopes =
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
                return true;
              }),
              path,
            }),
          ],
        }),
      });

      const { res } = makeMockHttpResponse();
      const handled = await handler({ url: path } as IncomingMessage, res, undefined, {
        gatewayAuthSatisfied,
        gatewayRequestOperatorScopes,
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(observedScopes).toEqual(expectedScopes);
    },
  );
});
