import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, isNodeCommandAllowedMock, resolveNodeCommandAllowlistMock } = vi.hoisted(
  () => ({
    isNodeCommandAllowedMock: vi.fn(),
    loadConfigMock: vi.fn(),
    resolveNodeCommandAllowlistMock: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../../../../src/gateway/node-command-policy.js", () => ({
  isNodeCommandAllowed: isNodeCommandAllowedMock,
  resolveNodeCommandAllowlist: resolveNodeCommandAllowlistMock,
}));

import { browserHandlers } from "./browser-request.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createContext() {
  const invoke = vi.fn(async () => ({
    ok: true,
    payload: {
      result: { ok: true },
    },
  }));
  const listConnected = vi.fn(() => [
    {
      caps: ["browser"],
      commands: ["browser.proxy"],
      nodeId: "node-1",
      platform: "linux",
    },
  ]);
  return {
    invoke,
    listConnected,
  };
}

async function runBrowserRequest(params: Record<string, unknown>) {
  const respond = vi.fn();
  const nodeRegistry = createContext();
  await browserHandlers["browser.request"]({
    client: null,
    context: { nodeRegistry } as never,
    isWebchatConnect: () => false,
    params,
    req: { id: "req-1", method: "browser.request", type: "req" },
    respond: respond as never,
  });
  return { nodeRegistry, respond };
}

describe("browser.request profile selection", () => {
  beforeEach(() => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto" } } },
    });
    resolveNodeCommandAllowlistMock.mockReturnValue([]);
    isNodeCommandAllowedMock.mockReturnValue({ ok: true });
  });

  it("uses profile from request body when query profile is missing", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
      method: "POST",
      path: "/act",
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          profile: "work",
        }),
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });

  it("prefers query profile over body profile when both are present", async () => {
    const { nodeRegistry } = await runBrowserRequest({
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          profile: "chrome",
        }),
      }),
    );
  });

  it.each([
    {
      body: { cdpUrl: "http://10.0.0.42:9222", name: "poc" },
      method: "POST",
      path: "/profiles/create",
    },
    {
      body: undefined,
      method: "DELETE",
      path: "/profiles/poc",
    },
    {
      body: { cdpUrl: "http://10.0.0.42:9222", name: "poc" },
      method: "POST",
      path: "profiles/create",
    },
    {
      body: undefined,
      method: "DELETE",
      path: "profiles/poc",
    },
    {
      body: { name: "poc", profile: "poc" },
      method: "POST",
      path: "/reset-profile",
    },
    {
      body: { name: "poc", profile: "poc" },
      method: "POST",
      path: "reset-profile",
    },
  ])("blocks persistent profile mutations for $method $path", async ({ method, path, body }) => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      body,
      method,
      path,
    });

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "browser.request cannot mutate persistent browser profiles",
      }),
    );
  });

  it("allows non-mutating profile reads", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "GET",
      path: "/profiles",
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          method: "GET",
          path: "/profiles",
        }),
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });
});
