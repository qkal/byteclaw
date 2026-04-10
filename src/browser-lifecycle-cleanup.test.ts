import { beforeEach, describe, expect, it, vi } from "vitest";

const closeTrackedBrowserTabsForSessions = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions,
}));

describe("cleanupBrowserSessionsForLifecycleEnd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes session keys before closing browser sessions", async () => {
    const { cleanupBrowserSessionsForLifecycleEnd } =
      await import("./browser-lifecycle-cleanup.js");
    const onWarn = vi.fn();

    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        onWarn,
        sessionKeys: ["", "  session-a  ", "session-a", "session-b"],
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      onWarn,
      sessionKeys: ["session-a", "session-b"],
    });
  });

  it("swallows browser cleanup failures", async () => {
    const { cleanupBrowserSessionsForLifecycleEnd } =
      await import("./browser-lifecycle-cleanup.js");
    const onError = vi.fn();
    const error = new Error("cleanup failed");
    closeTrackedBrowserTabsForSessions.mockRejectedValueOnce(error);

    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        onError,
        sessionKeys: ["session-a"],
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
