import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      action,
      context,
      messages: [],
      sessionKey,
      timestamp: new Date(),
      type,
    }),
  ),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

function makeGroupMessage(text: string) {
  return {
    chat: { id: -1_001_234_567_890, title: "Test Group", type: "supergroup" as const },
    date: 1_700_000_000,
    from: { first_name: "Alice", id: 99, username: "alice" },
    message_id: 42,
    text,
  };
}

describe("telegram mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const result = await buildTelegramMessageContextForTest({
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/sonnet-4.6",
            workspace: "/tmp/openclaw",
          },
        },
        channels: {
          telegram: {
            groups: {
              "*": {
                ingest: true,
                requireMention: true,
              },
            },
          },
        },
        messages: {
          groupChat: {
            mentionPatterns: ["@bot"],
          },
        },
      } as never,
      message: makeGroupMessage("hello without mention"),
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          ingest: true,
          requireMention: true,
        },
        topicConfig: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("telegram"),
      expect.objectContaining({
        channelId: "telegram",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("uses wildcard ingest when a specific group override omits ingest", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const result = await buildTelegramMessageContextForTest({
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/sonnet-4.6",
            workspace: "/tmp/openclaw",
          },
        },
        channels: {
          telegram: {
            groups: {
              "*": {
                ingest: true,
                requireMention: true,
              },
              "-1001234567890": {
                requireMention: true,
              },
            },
          },
        },
        messages: {
          groupChat: {
            mentionPatterns: ["@bot"],
          },
        },
      } as never,
      message: makeGroupMessage("hello without mention"),
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: true,
        },
        topicConfig: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("telegram"),
      expect.objectContaining({
        channelId: "telegram",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });
});
