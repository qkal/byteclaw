import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureScreenshot } from "./cdp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { shouldUsePlaywrightForScreenshot } from "./profile-capabilities.js";

const sentMessages = vi.hoisted(() => {
  const msgs: { method: string; params?: Record<string, unknown> }[] = [];
  return msgs;
});

// Tracks whether emulation has been cleared so post-clear Runtime.evaluate
// Can return different values for the "emulated tab" vs "non-emulated tab" tests.
const mockState = vi.hoisted(() => ({
  emulatedTab: true,
  emulationCleared: false,
  naturalViewport: { dpr: 1, h: 1080, w: 1920 },
  viewport: { dpr: 2, h: 600, sh: 600, sw: 800, w: 800 } as Record<string, unknown>,
}));

vi.mock("./cdp.helpers.js", () => ({
  appendCdpPath: vi.fn(),
  fetchJson: vi.fn(),
  isLoopbackHost: vi.fn(),
  isWebSocketUrl: vi.fn(),
  withCdpSocket: vi.fn(async (_wsUrl: string, fn: (send: unknown) => Promise<unknown>) => {
    const send = (method: string, params?: Record<string, unknown>) => {
      sentMessages.push({ method, params });
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({ data: "AAAA" });
      }
      if (method === "Page.getLayoutMetrics") {
        return Promise.resolve({
          contentSize: { height: 3000, width: 1200 },
          cssContentSize: { height: 3000, width: 1200 },
        });
      }
      if (method === "Emulation.clearDeviceMetricsOverride") {
        mockState.emulationCleared = true;
        return Promise.resolve({});
      }
      if (method === "Emulation.setDeviceMetricsOverride") {
        mockState.emulationCleared = false;
        return Promise.resolve({});
      }
      if (method === "Runtime.evaluate") {
        if (mockState.emulationCleared && mockState.emulatedTab) {
          return Promise.resolve({
            result: {
              value: mockState.naturalViewport,
            },
          });
        }
        return Promise.resolve({
          result: {
            value: mockState.viewport,
          },
        });
      }
      return Promise.resolve({});
    };
    return fn(send);
  }),
}));

vi.mock("./navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
}));

const localProfile: ResolvedBrowserProfile = {
  attachOnly: false,
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  cdpPort: 18_800,
  cdpUrl: "http://127.0.0.1:18800",
  color: "#FF4500",
  driver: "openclaw",
  name: "openclaw",
};

beforeEach(() => {
  sentMessages.length = 0;
  mockState.emulationCleared = false;
  mockState.emulatedTab = true;
  mockState.viewport = { dpr: 2, h: 600, sh: 600, sw: 800, w: 800 };
  mockState.naturalViewport = { dpr: 1, h: 1080, w: 1920 };
});

describe("CDP screenshot params", () => {
  it("viewport screenshot omits fromSurface without clip or emulation override", async () => {
    await captureScreenshot({ format: "png", wsUrl: "ws://localhost:9222/devtools/page/X" });

    const call = sentMessages.find((m) => m.method === "Page.captureScreenshot");
    expect(call).toBeDefined();
    expect(call!.params).toMatchObject({
      captureBeyondViewport: true,
      format: "png",
    });
    expect(call!.params).not.toHaveProperty("fromSurface");
    expect(call!.params).not.toHaveProperty("clip");

    const emulationCalls = sentMessages.filter(
      (m) => m.method === "Emulation.setDeviceMetricsOverride",
    );
    expect(emulationCalls).toHaveLength(0);
  });

  it("fullPage on emulated tab: clears, detects drift, re-applies saved emulation", async () => {
    mockState.emulatedTab = true;

    await captureScreenshot({
      format: "png",
      fullPage: true,
      wsUrl: "ws://localhost:9222/devtools/page/X",
    });

    const setCalls = sentMessages.filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    expect(setCalls.length).toBe(2);
    const [firstSetCall, secondSetCall] = setCalls;
    if (!firstSetCall || !secondSetCall) {
      throw new Error("expected two viewport updates");
    }

    // Expand: uses saved DPR, mobile defaults to false
    expect(firstSetCall.params).toMatchObject({
      deviceScaleFactor: 2,
      height: 3000,
      mobile: false,
      width: 1200,
    });

    // Clear is called first in the finally block
    const clearCall = sentMessages.find((m) => m.method === "Emulation.clearDeviceMetricsOverride");
    expect(clearCall).toBeDefined();

    // Viewport drifted after clear → re-apply saved dimensions
    expect(secondSetCall.params).toMatchObject({
      deviceScaleFactor: 2,
      height: 600,
      mobile: false,
      screenHeight: 600,
      screenWidth: 800,
      width: 800,
    });
  });

  it("fullPage on non-emulated tab: clears and does NOT re-apply emulation", async () => {
    mockState.emulatedTab = false;
    mockState.viewport = { dpr: 1, h: 1080, sh: 1080, sw: 1920, w: 1920 };
    mockState.naturalViewport = { dpr: 1, h: 1080, w: 1920 };

    await captureScreenshot({
      format: "png",
      fullPage: true,
      wsUrl: "ws://localhost:9222/devtools/page/X",
    });

    const setCalls = sentMessages.filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    // Only the expand call — no re-apply after clear
    expect(setCalls).toHaveLength(1);

    const clearCall = sentMessages.find((m) => m.method === "Emulation.clearDeviceMetricsOverride");
    expect(clearCall).toBeDefined();
  });

  it("fullPage viewport dimensions never shrink below current innerWidth/Height", async () => {
    await captureScreenshot({ fullPage: true, wsUrl: "ws://localhost:9222/devtools/page/X" });

    const expandCall = sentMessages.find((m) => m.method === "Emulation.setDeviceMetricsOverride");
    expect(expandCall).toBeDefined();
    expect(Number(expandCall!.params!.width)).toBeGreaterThanOrEqual(800);
    expect(Number(expandCall!.params!.height)).toBeGreaterThanOrEqual(600);
  });
});

describe("shouldUsePlaywrightForScreenshot routing", () => {
  it("returns false for a normal viewport screenshot with wsUrl", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x" })).toBe(
      false,
    );
  });

  it("returns true when wsUrl is missing", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile })).toBe(true);
  });

  it("returns true when ref is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({ profile: localProfile, ref: "btn-1", wsUrl: "ws://x" }),
    ).toBe(true);
  });

  it("returns true when element is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({
        element: "#submit",
        profile: localProfile,
        wsUrl: "ws://x",
      }),
    ).toBe(true);
  });
});
