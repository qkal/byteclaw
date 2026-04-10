import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { saveSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";
import { initSessionState } from "./session.js";

describe("initSessionState - heartbeat should not trigger session reset", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp("/tmp/openclaw-test-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  const createBaseConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        workspace: tempDir,
      },
      list: [
        {
          id: "main",
          workspace: tempDir,
        },
      ],
    },
    channels: {},
    gateway: {
      auth: { mode: "token", token: "test" },
      bind: "loopback",
      mode: "local",
      port: 18_789,
    },
    plugins: {
      entries: {},
    },
    session: {
      reset: {
        idleMinutes: 5,
        mode: "idle", // 5 minutes idle timeout
      },
      store: storePath,
    },
  });

  const createBaseCtx = (overrides?: Partial<MsgContext>): MsgContext => ({
    Body: "test message",
    ChatType: "direct",
    CommandAuthorized: true,
    From: "user123",
    Provider: "telegram",
    SessionKey: "main:user123",
    Surface: "telegram",
    To: "bot123",
    ...overrides,
  });

  it("should NOT reset session when Provider is 'heartbeat'", async () => {
    // Setup: Create a session entry that is "stale" (older than idle timeout)
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000; // 10 minutes ago (exceeds 5min idle timeout)

    const initialStore: Record<string, SessionEntry> = {
      "main:user123": {
        sessionId: "original-session-id-12345",
        systemSent: true,
        updatedAt: staleTime,
      },
    };
    await saveSessionStore(storePath, initialStore);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "heartbeat", // Heartbeat provider should NOT trigger reset
      Body: "HEARTBEAT_OK",
    });

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    // Assert: Session should NOT be reset (same sessionId)
    expect(result.isNewSession).toBe(false);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).toBe("original-session-id-12345");
    expect(result.sessionEntry.sessionId).toBe("original-session-id-12345");
  });

  it("should reset session when Provider is NOT 'heartbeat' and session is stale", async () => {
    // Setup: Create a session entry that is "stale" (older than idle timeout)
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000; // 10 minutes ago (exceeds 5min idle timeout)

    const initialStore: Record<string, SessionEntry> = {
      "main:user123": {
        sessionId: "original-session-id-12345",
        systemSent: true,
        updatedAt: staleTime,
      },
    };
    await saveSessionStore(storePath, initialStore);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "telegram", // Regular provider - SHOULD trigger reset if stale
      Body: "test message",
    });

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    // Assert: Session SHOULD be reset (new sessionId) because it's stale
    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false); // Not a manual reset, but idle reset
    expect(result.sessionId).not.toBe("original-session-id-12345");
  });

  it("should preserve session when Provider is 'heartbeat' even with daily reset mode", async () => {
    // Setup: Create a session entry from yesterday (would trigger daily reset)
    const now = Date.now();
    const yesterday = now - 25 * 60 * 60 * 1000; // 25 hours ago

    const initialStore: Record<string, SessionEntry> = {
      "main:user123": {
        sessionId: "original-session-id-67890",
        systemSent: true,
        updatedAt: yesterday,
      },
    };
    await saveSessionStore(storePath, initialStore);

    const cfg = createBaseConfig();
    cfg.session!.reset = {
      atHour: 4,
      mode: "daily", // 4 AM daily reset
    };

    const ctx = createBaseCtx({
      Body: "HEARTBEAT_OK",
      Provider: "heartbeat",
    });

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    // Assert: Session should NOT be reset even though it's past daily reset time
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("original-session-id-67890");
  });

  it("should handle cron-event provider same as heartbeat (no reset)", async () => {
    // Setup: Create a stale session
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000;

    const initialStore: Record<string, SessionEntry> = {
      "main:user123": {
        sessionId: "cron-session-id-abcde",
        systemSent: true,
        updatedAt: staleTime,
      },
    };
    await saveSessionStore(storePath, initialStore);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "cron-event", // Cron events should also NOT trigger reset
      Body: "cron job output",
    });

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    // Assert: Session should NOT be reset for cron events either
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("cron-session-id-abcde");
  });

  it("should handle exec-event provider same as heartbeat (no reset)", async () => {
    // Setup: Create a stale session
    const now = Date.now();
    const staleTime = now - 10 * 60 * 1000;

    const initialStore: Record<string, SessionEntry> = {
      "main:user123": {
        sessionId: "exec-session-id-fghij",
        systemSent: true,
        updatedAt: staleTime,
      },
    };
    await saveSessionStore(storePath, initialStore);

    const cfg = createBaseConfig();
    const ctx = createBaseCtx({
      Provider: "exec-event", // Exec events should also NOT trigger reset
      Body: "exec completion",
    });

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    // Assert: Session should NOT be reset for exec events either
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("exec-session-id-fghij");
  });
});
