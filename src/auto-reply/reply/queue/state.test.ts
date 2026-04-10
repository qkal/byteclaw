import { afterEach, describe, expect, it } from "vitest";
import { clearFollowupQueue, getFollowupQueue, refreshQueuedFollowupSession } from "./state.js";
import type { FollowupRun } from "./types.js";

const QUEUE_KEY = "agent:main:dm:test";

afterEach(() => {
  clearFollowupQueue(QUEUE_KEY);
});

function makeRun(): FollowupRun["run"] {
  return {
    agentDir: "/tmp/agent",
    agentId: "main",
    authProfileId: "profile-a",
    authProfileIdSource: "user",
    blockReplyBreak: "message_end",
    config: {} as FollowupRun["run"]["config"],
    model: "claude-opus-4-6",
    provider: "anthropic",
    sessionFile: "/tmp/session-1.jsonl",
    sessionId: "session-1",
    sessionKey: QUEUE_KEY,
    timeoutMs: 30_000,
    workspaceDir: "/tmp/workspace",
  };
}

describe("refreshQueuedFollowupSession", () => {
  it("retargets queued runs to the persisted selection", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "queue" });
    const lastRun = makeRun();
    const queuedRun: FollowupRun = {
      enqueuedAt: Date.now(),
      prompt: "queued message",
      run: makeRun(),
    };
    queue.lastRun = lastRun;
    queue.items.push(queuedRun);

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
      nextModel: "gpt-4o",
      nextProvider: "openai",
    });

    expect(queue.lastRun).toMatchObject({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "gpt-4o",
      provider: "openai",
    });
    expect(queue.items[0]?.run).toMatchObject({
      authProfileId: undefined,
      authProfileIdSource: undefined,
      model: "gpt-4o",
      provider: "openai",
    });
  });
});
