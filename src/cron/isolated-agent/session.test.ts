import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: vi.fn(),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../config/sessions/reset.js", () => ({
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ idleMinutes: 60, mode: "idle" }),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: vi.fn(),
  clearBootstrapSnapshotOnSessionRollover: vi.fn(({ sessionKey, previousSessionId }) => {
    if (sessionKey && previousSessionId) {
      clearBootstrapSnapshot(sessionKey);
    }
  }),
}));

import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { evaluateSessionFreshness } from "../../config/sessions/reset.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { resolveCronSession } from "./session.js";

const NOW_MS = 1_737_600_000_000;

type SessionStore = ReturnType<typeof loadSessionStore>;
type SessionStoreEntry = SessionStore[string];
type MockSessionStoreEntry = Partial<SessionStoreEntry>;

function resolveWithStoredEntry(params?: {
  sessionKey?: string;
  entry?: MockSessionStoreEntry;
  forceNew?: boolean;
  fresh?: boolean;
}) {
  const sessionKey = params?.sessionKey ?? "webhook:stable-key";
  const store: SessionStore = params?.entry
    ? ({ [sessionKey]: params.entry as SessionStoreEntry } as SessionStore)
    : {};
  vi.mocked(loadSessionStore).mockReturnValue(store);
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });

  return resolveCronSession({
    agentId: "main",
    cfg: {} as OpenClawConfig,
    forceNew: params?.forceNew,
    nowMs: NOW_MS,
    sessionKey,
  });
}

describe("resolveCronSession", () => {
  beforeEach(() => {
    vi.mocked(clearBootstrapSnapshot).mockReset();
  });

  it("preserves modelOverride and providerOverride from existing session entry", () => {
    const result = resolveWithStoredEntry({
      entry: {
        model: "kimi-code",
        modelOverride: "deepseek-v3-4bit-mlx",
        providerOverride: "inferencer",
        sessionId: "old-session-id",
        thinkingLevel: "high",
        updatedAt: 1000,
      },
      sessionKey: "agent:main:cron:test-job",
    });

    expect(result.sessionEntry.modelOverride).toBe("deepseek-v3-4bit-mlx");
    expect(result.sessionEntry.providerOverride).toBe("inferencer");
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    // The model field (last-used model) should also be preserved
    expect(result.sessionEntry.model).toBe("kimi-code");
  });

  it("handles missing modelOverride gracefully", () => {
    const result = resolveWithStoredEntry({
      entry: {
        model: "claude-opus-4-6",
        sessionId: "old-session-id",
        updatedAt: 1000,
      },
      sessionKey: "agent:main:cron:test-job",
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
  });

  it("handles no existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:new-job",
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.model).toBeUndefined();
    expect(result.isNewSession).toBe(true);
  });

  // New tests for session reuse behavior (#18027)
  describe("session reuse for webhooks/cron", () => {
    it("reuses existing sessionId when session is fresh", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-123",
          systemSent: true,
          updatedAt: NOW_MS - 1000,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("existing-session-id-123");
      expect(result.isNewSession).toBe(false);
      expect(result.systemSent).toBe(true);
      expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
    });

    it("creates new sessionId when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000, // 1 day ago
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          sendPolicy: "allow",
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("creates new sessionId when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
          sessionId: "existing-session-id-456",
          systemSent: true,
          updatedAt: NOW_MS - 1000,
        },
        forceNew: true,
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("clears delivery routing metadata and deliveryContext when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          deliveryContext: {
            channel: "slack",
            threadId: "1737500000.123456",
            to: "channel:C0XXXXXXXXX",
          },
          lastAccountId: "acct-123",
          lastChannel: "slack" as never,
          lastThreadId: "1737500000.123456",
          lastTo: "channel:C0XXXXXXXXX",
          modelOverride: "gpt-5.4",
          sessionId: "existing-session-id-789",
          systemSent: true,
          updatedAt: NOW_MS - 1000,
        },
        forceNew: true,
        fresh: true,
      });

      expect(result.isNewSession).toBe(true);
      // Delivery routing state must be cleared to prevent thread leaking.
      // DeliveryContext must also be cleared because normalizeSessionEntryDelivery
      // Repopulates lastThreadId from deliveryContext.threadId on store writes.
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
      // Per-session overrides must be preserved
      expect(result.sessionEntry.modelOverride).toBe("gpt-5.4");
    });

    it("clears delivery routing metadata when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          deliveryContext: {
            channel: "slack",
            threadId: "1737500000.999999",
            to: "channel:C0XXXXXXXXX",
          },
          lastChannel: "slack" as never,
          lastThreadId: "1737500000.999999",
          lastTo: "channel:C0XXXXXXXXX",
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
        },
        fresh: false,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
    });

    it("preserves delivery routing metadata when reusing fresh session", () => {
      const result = resolveWithStoredEntry({
        entry: {
          deliveryContext: {
            channel: "slack",
            threadId: "1737500000.123456",
            to: "channel:C0XXXXXXXXX",
          },
          lastChannel: "slack" as never,
          lastThreadId: "1737500000.123456",
          lastTo: "channel:C0XXXXXXXXX",
          sessionId: "existing-session-id-101",
          systemSent: true,
          updatedAt: NOW_MS - 1000,
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionEntry.lastChannel).toBe("slack");
      expect(result.sessionEntry.lastTo).toBe("channel:C0XXXXXXXXX");
      expect(result.sessionEntry.lastThreadId).toBe("1737500000.123456");
      expect(result.sessionEntry.deliveryContext).toEqual({
        channel: "slack",
        threadId: "1737500000.123456",
        to: "channel:C0XXXXXXXXX",
      });
    });

    it("creates new sessionId when entry exists but has no sessionId", () => {
      const result = resolveWithStoredEntry({
        entry: {
          modelOverride: "some-model",
          updatedAt: NOW_MS - 1000,
        },
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
      // Should still preserve other fields from entry
      expect(result.sessionEntry.modelOverride).toBe("some-model");
    });
  });
});
