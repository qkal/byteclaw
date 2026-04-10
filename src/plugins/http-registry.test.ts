import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPluginHttpRoute } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

function expectRouteRegistrationDenied(params: {
  replaceExisting: boolean;
  expectedLogFragment: string;
}) {
  const { registry, logs, register } = createLoggedRouteHarness();

  register({
    auth: "plugin",
    path: "/plugins/demo",
    pluginId: "demo-a",
    source: "demo-a-src",
  });

  const unregister = register({
    path: "/plugins/demo",
    auth: "plugin",
    ...(params.replaceExisting ? { replaceExisting: true } : {}),
    pluginId: "demo-b",
    source: "demo-b-src",
  });

  expect(registry.httpRoutes).toHaveLength(1);
  expect(logs.at(-1)).toContain(params.expectedLogFragment);

  unregister();
  expect(registry.httpRoutes).toHaveLength(1);
}

function expectRegisteredRouteShape(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
  params: {
    path: string;
    handler?: unknown;
    auth: "plugin" | "gateway";
    match?: "exact" | "prefix";
  },
) {
  expect(registry.httpRoutes).toHaveLength(1);
  expect(registry.httpRoutes[0]).toEqual(
    expect.objectContaining({
      auth: params.auth,
      path: params.path,
      ...(params.match ? { match: params.match } : {}),
      ...(params.handler ? { handler: params.handler } : {}),
    }),
  );
}

function createLoggedRouteHarness() {
  const registry = createEmptyPluginRegistry();
  const logs: string[] = [];
  return {
    logs,
    register: (
      params: Omit<
        Parameters<typeof registerPluginHttpRoute>[0],
        "registry" | "handler" | "log"
      > & {
        handler?: Parameters<typeof registerPluginHttpRoute>[0]["handler"];
      },
    ) =>
      registerPluginHttpRoute({
        ...params,
        handler: params.handler ?? vi.fn(),
        log: (msg) => logs.push(msg),
        registry,
      }),
    registry,
  };
}

describe("registerPluginHttpRoute", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("registers route and unregisters it", () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn();

    const unregister = registerPluginHttpRoute({
      auth: "plugin",
      handler,
      path: "/plugins/demo",
      registry,
    });

    expectRegisteredRouteShape(registry, {
      auth: "plugin",
      handler,
      match: "exact",
      path: "/plugins/demo",
    });

    unregister();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("returns noop unregister when path is missing", () => {
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];
    const unregister = registerPluginHttpRoute({
      accountId: "default",
      auth: "plugin",
      handler: vi.fn(),
      log: (msg) => logs.push(msg),
      path: "",
      registry,
    });

    expect(registry.httpRoutes).toHaveLength(0);
    expect(logs).toEqual(['plugin: webhook path missing for account "default"']);
    expect(() => unregister()).not.toThrow();
  });

  it("replaces stale route on same path when replaceExisting=true", () => {
    const { registry, logs, register } = createLoggedRouteHarness();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const unregisterFirst = register({
      accountId: "default",
      auth: "plugin",
      handler: firstHandler,
      path: "/plugins/synology",
      pluginId: "synology-chat",
    });

    const unregisterSecond = register({
      accountId: "default",
      auth: "plugin",
      handler: secondHandler,
      path: "/plugins/synology",
      pluginId: "synology-chat",
      replaceExisting: true,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);
    expect(logs).toContain(
      'plugin: replacing stale webhook path /plugins/synology (exact) for account "default" (synology-chat)',
    );

    // Old unregister must not remove the replacement route.
    unregisterFirst();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);

    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it.each([
    {
      expectedLogFragment: "route conflict",
      name: "rejects conflicting route registrations without replaceExisting",
      replaceExisting: false,
    },
    {
      expectedLogFragment: "route replacement denied",
      name: "rejects route replacement when a different plugin owns the route",
      replaceExisting: true,
    },
  ] as const)("$name", ({ replaceExisting, expectedLogFragment }) => {
    expectRouteRegistrationDenied({
      expectedLogFragment,
      replaceExisting,
    });
  });

  it("rejects mixed-auth overlapping routes", () => {
    const { registry, logs, register } = createLoggedRouteHarness();

    register({
      auth: "gateway",
      match: "prefix",
      path: "/plugin/secure",
      pluginId: "demo-gateway",
      source: "demo-gateway-src",
    });

    const unregister = register({
      auth: "plugin",
      match: "exact",
      path: "/plugin/secure/report",
      pluginId: "demo-plugin",
      source: "demo-plugin-src",
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(logs.at(-1)).toContain("route overlap denied");

    unregister();
    expect(registry.httpRoutes).toHaveLength(1);
  });

  it("uses the pinned route registry when the active registry changes later", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterActiveRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);
    setActivePluginRegistry(laterActiveRegistry);

    const unregister = registerPluginHttpRoute({
      auth: "plugin",
      handler: vi.fn(),
      path: "/bluebubbles-webhook",
    });

    expectRegisteredRouteShape(startupRegistry, {
      auth: "plugin",
      path: "/bluebubbles-webhook",
    });
    expect(laterActiveRegistry.httpRoutes).toHaveLength(0);

    unregister();
    expect(startupRegistry.httpRoutes).toHaveLength(0);
  });
});
