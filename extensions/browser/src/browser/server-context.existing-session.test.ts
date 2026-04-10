import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserServerState } from "./server-context.js";

vi.mock("./chrome-mcp.js", () => ({
  closeChromeMcpSession: vi.fn(async () => true),
  closeChromeMcpTab: vi.fn(async () => {}),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  focusChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", type: "page", url: "https://example.com" },
  ]),
  openChromeMcpTab: vi.fn(async () => ({
    targetId: "8",
    title: "",
    type: "page",
    url: "https://openclaw.ai",
  })),
}));

const { createBrowserRouteContext } = await import("./server-context.js");
const chromeMcp = await import("./chrome-mcp.js");

function makeState(): BrowserServerState {
  return {
    port: 0,
    profiles: new Map(),
    resolved: {
      attachOnly: false,
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      cdpPortRangeEnd: 18_899,
      cdpPortRangeStart: 18_800,
      cdpProtocol: "http",
      color: "#FF4500",
      controlPort: 18_791,
      defaultProfile: "chrome-live",
      enabled: true,
      evaluateEnabled: true,
      extraArgs: [],
      headless: false,
      noSandbox: false,
      profiles: {
        "chrome-live": {
          attachOnly: true,
          cdpPort: 18_801,
          color: "#0066CC",
          driver: "existing-session",
          userDataDir: "/tmp/brave-profile",
        },
      },
      remoteCdpHandshakeTimeoutMs: 3000,
      remoteCdpTimeoutMs: 1500,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
    server: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("browser server-context existing-session profile", () => {
  it("routes tab operations through the Chrome MCP backend", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.listChromeMcpTabs)
      .mockResolvedValueOnce([
        { targetId: "7", title: "", type: "page", url: "https://example.com" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", type: "page", url: "https://example.com" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", type: "page", url: "https://example.com" },
        { targetId: "8", title: "", type: "page", url: "https://openclaw.ai" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", type: "page", url: "https://example.com" },
        { targetId: "8", title: "", type: "page", url: "https://openclaw.ai" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", type: "page", url: "https://example.com" },
        { targetId: "8", title: "", type: "page", url: "https://openclaw.ai" },
      ]);

    await live.ensureBrowserAvailable();
    const tabs = await live.listTabs();
    expect(tabs.map((tab) => tab.targetId)).toEqual(["7"]);

    const opened = await live.openTab("https://openclaw.ai");
    expect(opened.targetId).toBe("8");

    const selected = await live.ensureTabAvailable();
    expect(selected.targetId).toBe("8");

    await live.focusTab("7");
    await live.stopRunningBrowser();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      "/tmp/brave-profile",
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith("chrome-live", "/tmp/brave-profile");
    expect(chromeMcp.openChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "https://openclaw.ai",
      "/tmp/brave-profile",
    );
    expect(chromeMcp.focusChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "7",
      "/tmp/brave-profile",
    );
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledWith("chrome-live");
  });
});
