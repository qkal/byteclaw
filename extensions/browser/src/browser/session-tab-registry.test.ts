import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __countTrackedSessionBrowserTabsForTests,
  __resetTrackedSessionBrowserTabsForTests,
  closeTrackedBrowserTabsForSessions,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

describe("session tab registry", () => {
  beforeEach(() => {
    __resetTrackedSessionBrowserTabsForTests();
  });

  afterEach(() => {
    __resetTrackedSessionBrowserTabsForTests();
  });

  it("tracks and closes tabs for normalized session keys", async () => {
    trackSessionBrowserTab({
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
      sessionKey: "Agent:Main:Main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
      sessionKey: "agent:main:main",
      targetId: "tab-b",
    });
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(2);

    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      closeTab,
      sessionKeys: ["agent:main:main"],
    });

    expect(closed).toBe(2);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab).toHaveBeenNthCalledWith(1, {
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
      targetId: "tab-a",
    });
    expect(closeTab).toHaveBeenNthCalledWith(2, {
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
      targetId: "tab-b",
    });
    expect(__countTrackedSessionBrowserTabsForTests()).toBe(0);
  });

  it("untracks specific tabs", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
    });
    untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });

    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      closeTab,
      sessionKeys: ["agent:main:main"],
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith({
      baseUrl: undefined,
      profile: undefined,
      targetId: "tab-b",
    });
  });

  it("deduplicates tabs and ignores expected close errors", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-b",
    });
    const warnings: string[] = [];
    const closeTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("target not found"))
      .mockRejectedValueOnce(new Error("network down"));

    const closed = await closeTrackedBrowserTabsForSessions({
      closeTab,
      onWarn: (message) => warnings.push(message),
      sessionKeys: ["agent:main:main", "main"],
    });

    expect(closed).toBe(0);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([expect.stringContaining("network down")]);
    expect(__countTrackedSessionBrowserTabsForTests()).toBe(0);
  });
});
