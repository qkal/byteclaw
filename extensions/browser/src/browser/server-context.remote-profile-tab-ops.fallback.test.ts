import { describe, expect, it, vi } from "vitest";
import {
  type RemoteProfileTestDeps,
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

describe("browser remote profile fallback and attachOnly behavior", () => {
  it("uses profile-level attachOnly when global attachOnly is false", async () => {
    const state = deps.makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      attachOnly: true,
      cdpPort: 18_800,
      color: "#FF4500",
    };

    const reachableMock = vi
      .mocked(deps.chromeModule.isChromeReachable)
      .mockResolvedValueOnce(false);
    const launchMock = vi.mocked(deps.chromeModule.launchOpenClawChrome);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled/i,
    );
    expect(reachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("keeps attachOnly websocket failures off the loopback ownership error path", async () => {
    const state = deps.makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      attachOnly: true,
      cdpPort: 18_800,
      color: "#FF4500",
    };

    const httpReachableMock = vi
      .mocked(deps.chromeModule.isChromeReachable)
      .mockResolvedValueOnce(true);
    const wsReachableMock = vi
      .mocked(deps.chromeModule.isChromeCdpReady)
      .mockResolvedValueOnce(false);
    const launchMock = vi.mocked(deps.chromeModule.launchOpenClawChrome);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled and CDP websocket/i,
    );
    expect(httpReachableMock).toHaveBeenCalled();
    expect(wsReachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("falls back to /json/list when Playwright is not available", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { remote } = deps.createRemoteRouteHarness(
      vi.fn(
        deps.createJsonListFetchMock([
          {
            id: "T1",
            title: "Tab 1",
            type: "page",
            url: "https://example.com",
            webSocketDebuggerUrl: "wss://browserless.example/devtools/page/T1",
          },
        ]),
      ),
    );

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
  });

  it("fails closed for remote tab opens in strict mode without Playwright", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();
    state.resolved.ssrfPolicy = {};

    await expect(remote.openTab("https://example.com")).rejects.toBeInstanceOf(
      deps.InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not enforce managed tab cap for remote openclaw profiles", async () => {
    const listPagesViaPlaywright = vi
      .fn()
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", type: "page", url: "https://1.example" },
      ])
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", type: "page", url: "https://1.example" },
        { targetId: "T2", title: "2", type: "page", url: "https://2.example" },
        { targetId: "T3", title: "3", type: "page", url: "https://3.example" },
        { targetId: "T4", title: "4", type: "page", url: "https://4.example" },
        { targetId: "T5", title: "5", type: "page", url: "https://5.example" },
        { targetId: "T6", title: "6", type: "page", url: "https://6.example" },
        { targetId: "T7", title: "7", type: "page", url: "https://7.example" },
        { targetId: "T8", title: "8", type: "page", url: "https://8.example" },
        { targetId: "T9", title: "9", type: "page", url: "https://9.example" },
      ]);

    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      type: "page",
      url: "https://1.example",
    }));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      createPageViaPlaywright,
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const fetchMock = vi.fn(async (url: unknown) => {
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { remote } = deps.createRemoteRouteHarness(fetchMock);
    const opened = await remote.openTab("https://1.example");
    expect(opened.targetId).toBe("T1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
