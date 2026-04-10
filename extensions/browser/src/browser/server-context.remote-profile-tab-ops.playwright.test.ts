import { describe, expect, it, vi } from "vitest";
import {
  type RemoteProfileTestDeps,
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

describe("browser remote profile tab ops via Playwright", () => {
  it("uses Playwright tab operations when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", type: "page", url: "https://example.com" },
    ]);
    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T2",
      title: "Tab 2",
      type: "page",
      url: "http://127.0.0.1:3000",
    }));
    const closePageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      closePageByTargetIdViaPlaywright,
      createPageViaPlaywright,
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);

    const opened = await remote.openTab("http://127.0.0.1:3000");
    expect(opened.targetId).toBe("T2");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      ssrfPolicy: { allowPrivateNetwork: true },
      url: "http://127.0.0.1:3000",
    });

    await remote.closeTab("T1");
    expect(closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers lastTargetId for remote profiles when targetId is omitted", async () => {
    const responses = [
      [
        { targetId: "A", title: "A", type: "page", url: "https://example.com" },
        { targetId: "B", title: "B", type: "page", url: "https://www.example.com" },
      ],
      [
        { targetId: "A", title: "A", type: "page", url: "https://example.com" },
        { targetId: "B", title: "B", type: "page", url: "https://www.example.com" },
      ],
      [
        { targetId: "B", title: "B", type: "page", url: "https://www.example.com" },
        { targetId: "A", title: "A", type: "page", url: "https://example.com" },
      ],
      [
        { targetId: "B", title: "B", type: "page", url: "https://www.example.com" },
        { targetId: "A", title: "A", type: "page", url: "https://example.com" },
      ],
    ];

    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      closePageByTargetIdViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected close");
      }),
      createPageViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected create");
      }),
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();

    const first = await remote.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await remote.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("rejects stale targetId for remote profiles even when only one tab remains", async () => {
    const responses = [
      [{ targetId: "T1", title: "Tab 1", type: "page", url: "https://example.com" }],
      [{ targetId: "T1", title: "Tab 1", type: "page", url: "https://example.com" }],
    ];
    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("keeps rejecting stale targetId for remote profiles when multiple tabs exist", async () => {
    const responses = [
      [
        { targetId: "A", title: "A", type: "page", url: "https://a.example" },
        { targetId: "B", title: "B", type: "page", url: "https://b.example" },
      ],
      [
        { targetId: "A", title: "A", type: "page", url: "https://a.example" },
        { targetId: "B", title: "B", type: "page", url: "https://b.example" },
      ],
    ];
    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("uses Playwright focus for remote profiles when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", type: "page", url: "https://example.com" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      focusPageByTargetIdViaPlaywright,
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

    await remote.focusTab("T1");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T1");
  });

  it("does not swallow Playwright runtime errors for remote profiles", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote, fetchMock } = deps.createRemoteRouteHarness();

    await expect(remote.listTabs()).rejects.toThrow(/boom/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
