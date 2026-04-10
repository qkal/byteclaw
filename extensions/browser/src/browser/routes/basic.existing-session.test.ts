import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
}));

const { BrowserProfileUnavailableError } = await import("../errors.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

function createExistingSessionProfileState(params?: { isHttpReachable?: () => Promise<boolean> }) {
  return {
    forProfile: () =>
      ({
        isHttpReachable: params?.isHttpReachable ?? (async () => true),
        isReachable: async () => true,
        profile: {
          attachOnly: true,
          cdpPort: 0,
          cdpUrl: "",
          color: "#00AA00",
          driver: "existing-session",
          name: "chrome-live",
          userDataDir: "/tmp/brave-profile",
        },
      }) as never,
    profiles: new Map(),
    resolved: {
      enabled: true,
      executablePath: undefined,
      headless: false,
      noSandbox: false,
    },
  };
}

async function callBasicRouteWithState(params: {
  query?: Record<string, string>;
  state: ReturnType<typeof createExistingSessionProfileState>;
}) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    forProfile: params.state.forProfile,
    state: () => params.state,
  } as never);

  const handler = getHandlers.get("/");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: params.query ?? { profile: "chrome-live" } }, response.res);
  return response;
}

describe("basic browser routes", () => {
  it("maps existing-session status failures to JSON browser errors", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable: async () => {
          throw new BrowserProfileUnavailableError("attach failed");
        },
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: "attach failed" });
  });

  it("reports Chrome MCP transport without fake CDP fields", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      cdpPort: null,
      cdpUrl: null,
      driver: "existing-session",
      pid: 4321,
      profile: "chrome-live",
      running: true,
      transport: "chrome-mcp",
      userDataDir: "/tmp/brave-profile",
    });
  });
});
