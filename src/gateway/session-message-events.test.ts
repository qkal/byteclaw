import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

const cleanupDirs: string[] = [];
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let previousMinimalGateway: string | undefined;

beforeAll(async () => {
  previousMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
  if (previousMinimalGateway === undefined) {
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  } else {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimalGateway;
  }
});

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function withOperatorSessionSubscriber<T>(
  harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>,
  run: (ws: Awaited<ReturnType<typeof harness.openWs>>) => Promise<T>,
) {
  const ws = await harness.openWs();
  try {
    await connectOk(ws, { scopes: ["operator.read"] });
    await rpcReq(ws, "sessions.subscribe");
    return await run(ws);
  } finally {
    ws.close();
  }
}

function waitForSessionMessageEvent(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  );
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  vi.useFakeTimers();
  try {
    const outcome = params
      .watch()
      .then(() => "received")
      .catch(() => "timeout");
    await params.action?.();
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await expect(outcome).resolves.toBe("timeout");
  } finally {
    vi.useRealTimers();
  }
}

describe("session.message websocket events", () => {
  test("includes spawned session ownership metadata on lifecycle sessions.changed events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        child: {
          displayName: "Ops Child",
          forkedFromParent: true,
          sessionId: "sess-child",
          spawnDepth: 2,
          spawnedBy: "agent:main:parent",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          subagentControlScope: "children",
          subagentRole: "orchestrator",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(harness, async (ws) => {
      const changedEvent = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionLifecycleEvent({
        reason: "reactivated",
        sessionKey: "agent:main:child",
      });

      const event = await changedEvent;
      expect(event.payload).toMatchObject({
        displayName: "Ops Child",
        forkedFromParent: true,
        reason: "reactivated",
        sessionKey: "agent:main:child",
        spawnDepth: 2,
        spawnedBy: "agent:main:parent",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
      });
    });
  });

  test("only sends transcript events to subscribed operator clients", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const subscribedWs = await harness.openWs();
    const unsubscribedWs = await harness.openWs();
    const nodeWs = await harness.openWs();
    try {
      await connectOk(subscribedWs, { scopes: ["operator.read"] });
      await rpcReq(subscribedWs, "sessions.subscribe");
      await connectOk(unsubscribedWs, { scopes: ["operator.read"] });
      await connectOk(nodeWs, { role: "node", scopes: [] });

      const subscribedEvent = onceMessage(
        subscribedWs,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        storePath,
        text: "subscribed only",
      });
      expect(appended.ok).toBe(true);
      await expect(subscribedEvent).resolves.toBeTruthy();
      await expectNoMessageWithin({
        watch: () =>
          onceMessage(
            unsubscribedWs,
            (message) => message.type === "event" && message.event === "session.message",
            300,
          ),
      });
      await expectNoMessageWithin({
        watch: () =>
          onceMessage(
            nodeWs,
            (message) => message.type === "event" && message.event === "session.message",
            300,
          ),
      });
    } finally {
      subscribedWs.close();
      unsubscribedWs.close();
      nodeWs.close();
    }
  });

  test("broadcasts appended transcript messages with the session key", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        storePath,
        text: "live websocket message",
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) {
        throw new Error(`append failed: ${appended.reason}`);
      }
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "live websocket message" }],
            role: "assistant",
          }),
          messageId: appended.messageId,
          sessionFile: appended.sessionFile,
          sessionKey: "agent:main:main",
        }),
      );
      const transcript = await fs.readFile(appended.sessionFile, "utf8");
      expect(transcript).toContain('"live websocket message"');
    } finally {
      emitSpy.mockRestore();
    }
  });

  test("includes live usage metadata on session.message and sessions.changed transcript events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          contextTokens: 123_456,
          model: "gpt-5.4",
          modelProvider: "openai",
          sessionId: "sess-main",
          totalTokens: 0,
          totalTokensFresh: false,
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptPath = path.join(path.dirname(storePath), "sess-main.jsonl");
    const transcriptMessage = {
      content: [{ text: "usage snapshot", type: "text" }],
      model: "gpt-5.4",
      provider: "openai",
      role: "assistant",
      timestamp: Date.now(),
      usage: {
        cacheRead: 300,
        cacheWrite: 100,
        cost: { total: 0.0042 },
        input: 2000,
        output: 400,
      },
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ id: "sess-main", type: "session", version: 1 }),
        JSON.stringify({ id: "msg-usage", message: transcriptMessage }),
      ].join("\n"),
      "utf8",
    );

    await withOperatorSessionSubscriber(harness, async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      const changedEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
            "message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );

      emitSessionTranscriptUpdate({
        message: transcriptMessage,
        messageId: "msg-usage",
        sessionFile: transcriptPath,
        sessionKey: "agent:main:main",
      });

      const [messageEvent, changedEvent] = await Promise.all([
        messageEventPromise,
        changedEventPromise,
      ]);
      expect(messageEvent.payload).toMatchObject({
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        messageId: "msg-usage",
        messageSeq: 1,
        model: "gpt-5.4",
        modelProvider: "openai",
        sessionKey: "agent:main:main",
        totalTokens: 2400,
        totalTokensFresh: true,
      });
      expect(changedEvent.payload).toMatchObject({
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        messageId: "msg-usage",
        messageSeq: 1,
        model: "gpt-5.4",
        modelProvider: "openai",
        phase: "message",
        sessionKey: "agent:main:main",
        totalTokens: 2400,
        totalTokensFresh: true,
      });
    });
  });

  test("includes spawnedBy metadata on session.message and sessions.changed transcript events", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-child.jsonl");
    await writeSessionStore({
      entries: {
        child: {
          forkedFromParent: true,
          parentSessionKey: "agent:main:main",
          sessionFile: transcriptPath,
          sessionId: "sess-child",
          spawnDepth: 2,
          spawnedBy: "agent:main:main",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          subagentControlScope: "children",
          subagentRole: "orchestrator",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptMessage = {
      content: [{ text: "spawn metadata snapshot", type: "text" }],
      role: "assistant",
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ id: "sess-child", type: "session", version: 1 }),
        JSON.stringify({ id: "msg-spawn", message: transcriptMessage }),
      ].join("\n"),
      "utf8",
    );

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      await rpcReq(ws, "sessions.subscribe");

      const messageEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );
      const changedEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
            "message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionTranscriptUpdate({
        message: transcriptMessage,
        messageId: "msg-spawn",
        sessionFile: transcriptPath,
        sessionKey: "agent:main:child",
      });

      const [messageEvent, changedEvent] = await Promise.all([
        messageEventPromise,
        changedEventPromise,
      ]);
      expect(messageEvent.payload).toMatchObject({
        forkedFromParent: true,
        parentSessionKey: "agent:main:main",
        sessionKey: "agent:main:child",
        spawnDepth: 2,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
      });
      expect(changedEvent.payload).toMatchObject({
        forkedFromParent: true,
        parentSessionKey: "agent:main:main",
        phase: "message",
        sessionKey: "agent:main:child",
        spawnDepth: 2,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
      });
    } finally {
      ws.close();
    }
  });

  test("includes route thread metadata on session.message and sessions.changed transcript events", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-thread.jsonl");
    await writeSessionStore({
      entries: {
        main: {
          lastAccountId: "acct-1",
          lastChannel: "telegram",
          lastThreadId: 42,
          lastTo: "-100123",
          sessionFile: transcriptPath,
          sessionId: "sess-thread",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptMessage = {
      content: [{ text: "thread route snapshot", type: "text" }],
      role: "assistant",
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ id: "sess-thread", type: "session", version: 1 }),
        JSON.stringify({ id: "msg-thread", message: transcriptMessage }),
      ].join("\n"),
      "utf8",
    );

    await withOperatorSessionSubscriber(harness, async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      const changedEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
            "message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );

      emitSessionTranscriptUpdate({
        message: transcriptMessage,
        messageId: "msg-thread",
        sessionFile: transcriptPath,
        sessionKey: "agent:main:main",
      });

      const [messageEvent, changedEvent] = await Promise.all([
        messageEventPromise,
        changedEventPromise,
      ]);
      expect(messageEvent.payload).toMatchObject({
        lastAccountId: "acct-1",
        lastChannel: "telegram",
        lastThreadId: 42,
        lastTo: "-100123",
        sessionKey: "agent:main:main",
      });
      expect(changedEvent.payload).toMatchObject({
        lastAccountId: "acct-1",
        lastChannel: "telegram",
        lastThreadId: 42,
        lastTo: "-100123",
        phase: "message",
        sessionKey: "agent:main:main",
      });
    });
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        worker: {
          sessionId: "sess-worker",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "agent:main:main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const mainEvent = waitForSessionMessageEvent(ws, "agent:main:main");
      const [mainAppend] = await Promise.all([
        appendAssistantMessageToSessionTranscript({
          sessionKey: "agent:main:main",
          storePath,
          text: "main only",
        }),
        mainEvent,
      ]);
      expect(mainAppend.ok).toBe(true);

      await expectNoMessageWithin({
        action: async () => {
          const workerAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:worker",
            storePath,
            text: "worker hidden",
          });
          expect(workerAppend.ok).toBe(true);
        },
        watch: () =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:worker",
            300,
          ),
      });

      const unsubscribeRes = await rpcReq(ws, "sessions.messages.unsubscribe", {
        key: "agent:main:main",
      });
      expect(unsubscribeRes.ok).toBe(true);
      expect(unsubscribeRes.payload?.subscribed).toBe(false);

      await expectNoMessageWithin({
        action: async () => {
          const hiddenAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:main",
            storePath,
            text: "hidden after unsubscribe",
          });
          expect(hiddenAppend.ok).toBe(true);
        },
        watch: () =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            300,
          ),
      });
    } finally {
      ws.close();
    }
  });

  test("routes transcript-only updates to the freshest session owner when different sessionIds share a transcript path", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "shared.jsonl");
    await writeSessionStore({
      entries: {
        newer: {
          sessionFile: transcriptPath,
          sessionId: "sess-new",
          updatedAt: Date.now() + 10,
        },
        older: {
          sessionFile: transcriptPath,
          sessionId: "sess-old",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ id: "sess-new", type: "session", version: 1 }),
        JSON.stringify({
          id: "msg-shared",
          message: {
            content: [{ text: "shared transcript update", type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await withOperatorSessionSubscriber(harness, async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:newer");

      emitSessionTranscriptUpdate({
        message: {
          content: [{ text: "shared transcript update", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        messageId: "msg-shared",
        sessionFile: transcriptPath,
      });

      const messageEvent = await messageEventPromise;
      expect(messageEvent.payload).toMatchObject({
        messageId: "msg-shared",
        messageSeq: 1,
        sessionKey: "agent:main:newer",
      });
    });
  });
});
