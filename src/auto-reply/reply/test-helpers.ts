import { vi } from "vitest";
import type { FollowupRun } from "./queue.js";
import type { TypingController } from "./typing.js";

export function createMockTypingController(
  overrides: Partial<TypingController> = {},
): TypingController {
  return {
    cleanup: vi.fn(),
    isActive: vi.fn(() => false),
    markDispatchIdle: vi.fn(),
    markRunComplete: vi.fn(),
    onReplyStart: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    ...overrides,
  };
}

export function createMockFollowupRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  const skipProviderRuntimeHints = process.env.OPENCLAW_TEST_FAST === "1";
  const base: FollowupRun = {
    enqueuedAt: Date.now(),
    originatingTo: "channel:C1",
    prompt: "hello",
    run: {
      agentAccountId: "primary",
      agentDir: "/tmp/agent",
      agentId: "agent",
      bashElevated: {
        allowed: false,
        defaultLevel: "off",
        enabled: false,
      },
      blockReplyBreak: "message_end",
      config: {},
      elevatedLevel: "off",
      messageProvider: "whatsapp",
      model: "claude",
      provider: "anthropic",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      sessionKey: "main",
      skillsSnapshot: {
        prompt: "",
        skills: [],
      },
      skipProviderRuntimeHints,
      thinkLevel: "low",
      timeoutMs: 1000,
      verboseLevel: "off",
      workspaceDir: "/tmp",
    },
    summaryLine: "hello",
  };
  return {
    ...base,
    ...overrides,
    run: {
      ...base.run,
      ...overrides.run,
    },
  };
}
