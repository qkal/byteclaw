import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const listeners: (() => void)[] = [];

afterEach(() => {
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
});

describe("guardSessionManager transcript updates", () => {
  it("includes the session key when broadcasting appended non-tool-result messages", () => {
    const updates: SessionTranscriptUpdate[] = [];
    listeners.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    const sessionFile = "/tmp/openclaw-session-message-events.jsonl";
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
    });

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      content: [{ text: "hello from subagent", type: "text" }],
      role: "assistant",
      timestamp: Date.now(),
    } as AgentMessage);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      message: {
        role: "assistant",
      },
      sessionFile,
      sessionKey: "agent:main:worker",
    });
  });
});
