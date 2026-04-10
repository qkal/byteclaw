import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { initSessionState } from "./session.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runSessionEnd: hookRunnerMocks.runSessionEnd,
      runSessionStart: hookRunnerMocks.runSessionStart,
    }) as unknown as HookRunner,
}));

async function createStorePath(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(root, "sessions.json");
}

async function writeStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf8");
}

async function writeTranscript(
  storePath: string,
  sessionId: string,
  text = "hello",
): Promise<string> {
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      id: `${sessionId}-m1`,
      message: { content: text, role: "user" },
      type: "message",
    })}\n`,
    "utf8",
  );
  return transcriptPath;
}

describe("session hook context wiring", () => {
  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes sessionKey to session_start hook context", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-session-hook-start");
    await writeStore(storePath, {});
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "hello", SessionKey: sessionKey },
    });

    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(event).toMatchObject({ sessionKey });
    expect(context).toMatchObject({ agentId: "main", sessionKey });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
  });

  it("passes sessionKey to session_end hook context on reset", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-session-hook-end");
    const transcriptPath = await writeTranscript(storePath, "old-session");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionFile: transcriptPath,
        sessionId: "old-session",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "/new", SessionKey: sessionKey },
    });

    expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [event, context] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      reason: "new",
      sessionKey,
      transcriptArchived: true,
    });
    expect(context).toMatchObject({ agentId: "main", sessionKey });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
    expect(event?.sessionFile).toContain(".jsonl.reset.");

    const [startEvent, startContext] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(startEvent).toMatchObject({ resumedFrom: "old-session" });
    expect(event?.nextSessionId).toBe(startEvent?.sessionId);
    expect(startContext).toMatchObject({ sessionId: startEvent?.sessionId });
  });

  it("marks explicit /reset rollovers with reason reset", async () => {
    const sessionKey = "agent:main:telegram:direct:456";
    const storePath = await createStorePath("openclaw-session-hook-explicit-reset");
    const transcriptPath = await writeTranscript(storePath, "reset-session", "reset me");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionFile: transcriptPath,
        sessionId: "reset-session",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "/reset", SessionKey: sessionKey },
    });

    const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "reset" });
  });

  it("maps custom reset trigger aliases to the new-session reason", async () => {
    const sessionKey = "agent:main:telegram:direct:alias";
    const storePath = await createStorePath("openclaw-session-hook-reset-alias");
    const transcriptPath = await writeTranscript(storePath, "alias-session", "alias me");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionFile: transcriptPath,
        sessionId: "alias-session",
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: {
        resetTriggers: ["/fresh"],
        store: storePath,
      },
    } as OpenClawConfig;

    await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "/fresh", SessionKey: sessionKey },
    });

    const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "new" });
  });

  it("marks daily stale rollovers and exposes the archived transcript path", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionKey = "agent:main:telegram:direct:daily";
      const storePath = await createStorePath("openclaw-session-hook-daily");
      const transcriptPath = await writeTranscript(storePath, "daily-session", "daily");
      await writeStore(storePath, {
        [sessionKey]: {
          sessionFile: transcriptPath,
          sessionId: "daily-session",
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      const cfg = { session: { store: storePath } } as OpenClawConfig;

      await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: { Body: "hello", SessionKey: sessionKey },
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      const [startEvent] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
      expect(event).toMatchObject({
        reason: "daily",
        transcriptArchived: true,
      });
      expect(event?.sessionFile).toContain(".jsonl.reset.");
      expect(event?.nextSessionId).toBe(startEvent?.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks idle stale rollovers with reason idle", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionKey = "agent:main:telegram:direct:idle";
      const storePath = await createStorePath("openclaw-session-hook-idle");
      const transcriptPath = await writeTranscript(storePath, "idle-session", "idle");
      await writeStore(storePath, {
        [sessionKey]: {
          sessionFile: transcriptPath,
          sessionId: "idle-session",
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      const cfg = {
        session: {
          reset: {
            idleMinutes: 30,
            mode: "idle",
          },
          store: storePath,
        },
      } as OpenClawConfig;

      await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: { Body: "hello", SessionKey: sessionKey },
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      expect(event).toMatchObject({ reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers idle over daily when both rollover conditions are true", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
      const sessionKey = "agent:main:telegram:direct:overlap";
      const storePath = await createStorePath("openclaw-session-hook-overlap");
      const transcriptPath = await writeTranscript(storePath, "overlap-session", "overlap");
      await writeStore(storePath, {
        [sessionKey]: {
          sessionFile: transcriptPath,
          sessionId: "overlap-session",
          updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
        },
      });
      const cfg = {
        session: {
          reset: {
            atHour: 4,
            idleMinutes: 30,
            mode: "daily",
          },
          store: storePath,
        },
      } as OpenClawConfig;

      await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: { Body: "hello", SessionKey: sessionKey },
      });

      const [event] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
      expect(event).toMatchObject({ reason: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });
});
