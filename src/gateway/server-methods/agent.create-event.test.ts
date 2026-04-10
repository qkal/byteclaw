import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testState, writeSessionStore } from "../test-helpers.js";
import { agentHandlers } from "./agent.js";

describe("agent handler session create events", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-create-event-"));
    storePath = path.join(tempDir, "sessions.json");
    testState.sessionStorePath = storePath;
    await writeSessionStore({ entries: {} });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("emits sessions.changed with reason create for new agent sessions", async () => {
    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();

    await agentHandlers.agent({
      client: null,
      context: {
        addChatRun: vi.fn(),
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        dedupe: new Map(),
        deps: {} as never,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
        registerToolEventRecipient: vi.fn(),
      } as never,
      isWebchatConnect: () => false,
      params: {
        idempotencyKey: "idem-agent-create-event",
        message: "hi",
        sessionKey: "agent:main:subagent:create-test",
      },
      req: { id: "req-agent-create-event" } as never,
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "idem-agent-create-event",
        status: "accepted",
      }),
      undefined,
      { runId: "idem-agent-create-event" },
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        reason: "create",
        sessionKey: "agent:main:subagent:create-test",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });
});
