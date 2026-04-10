import { vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { ChannelOutboundAdapter, ChannelOutboundContext } from "../channels/plugins/types.js";
import { callGateway } from "../gateway/call.js";
import { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";

type TestSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId?: string } & Record<string, unknown>>;

function withRequiredMessageId(
  channel: "signal" | "telegram",
  result: Awaited<ReturnType<TestSendFn>>,
) {
  return {
    channel,
    ...result,
    messageId:
      typeof result.messageId === "string" && result.messageId.trim()
        ? result.messageId
        : `${channel}-test-message`,
  };
}

function parseTelegramTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^tg:/i, "");
  const match = /^group:([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (match) {
    return {
      chatId: match[1],
      chatType: "group",
      messageThreadId: Number.parseInt(match[2], 10),
    };
  }
  const topicMatch = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (topicMatch) {
    return {
      chatId: topicMatch[1],
      chatType: topicMatch[1].startsWith("-") ? "group" : "direct",
      messageThreadId: Number.parseInt(topicMatch[2], 10),
    };
  }
  const colonPair = /^([^:]+):(\d+)$/i.exec(trimmed);
  if (colonPair && colonPair[1].startsWith("-")) {
    return {
      chatId: colonPair[1],
      chatType: "group",
      messageThreadId: Number.parseInt(colonPair[2], 10),
    };
  }
  return {
    chatId: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : "unknown",
  };
}

function resolveRequiredTarget(label: string, raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { error: new Error(`${label} target is required`), ok: false as const };
  }
  return { ok: true as const, to: trimmed };
}

function resolveTestSender(
  channel: "signal" | "telegram",
  deps: ChannelOutboundContext["deps"],
): TestSendFn {
  const sender = resolveOutboundSendDep<TestSendFn>(deps, channel);
  if (!sender) {
    throw new Error(`missing ${channel} sender`);
  }
  return sender;
}

const telegramOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  resolveTarget: ({ to }) => {
    const resolved = resolveRequiredTarget("Telegram", to);
    if (!resolved.ok) {
      return resolved;
    }
    return { ok: true, to: parseTelegramTargetForTest(resolved.to).chatId };
  },
  sendText: async () => ({ channel: "telegram", messageId: "telegram-msg" }),
};

const signalOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  resolveTarget: ({ to }) => resolveRequiredTarget("Signal", to),
  sendText: async ({ cfg, to, text, accountId, deps }) =>
    withRequiredMessageId(
      "signal",
      await resolveTestSender("signal", deps)(to, text, {
        accountId: accountId ?? undefined,
        cfg,
      }),
    ),
};

telegramOutboundForTest.sendText = async ({ cfg, to, text, accountId, deps, threadId }) =>
  withRequiredMessageId(
    "telegram",
    await resolveTestSender("telegram", deps)(to, text, {
      accountId: accountId ?? undefined,
      cfg,
      messageThreadId: threadId ?? undefined,
    }),
  );

telegramOutboundForTest.sendMedia = async ({
  cfg,
  to,
  text,
  mediaUrl,
  mediaLocalRoots,
  mediaReadFile,
  accountId,
  deps,
  threadId,
}) =>
  withRequiredMessageId(
    "telegram",
    await resolveTestSender("telegram", deps)(to, text, {
      accountId: accountId ?? undefined,
      cfg,
      mediaLocalRoots,
      mediaReadFile,
      mediaUrl,
      messageThreadId: threadId ?? undefined,
    }),
  );

export function setupIsolatedAgentTurnMocks(params?: { fast?: boolean }): void {
  if (params?.fast) {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  }
  vi.mocked(runEmbeddedPiAgent).mockReset();
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(runSubagentAnnounceFlow).mockReset().mockResolvedValue(true);
  vi.mocked(callGateway).mockReset().mockResolvedValue({ deleted: true, ok: true });
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: createOutboundTestPlugin({
          id: "telegram",
          messaging: {
            parseExplicitTarget: ({ raw }) => {
              const target = parseTelegramTargetForTest(raw);
              return {
                to: target.chatId,
                threadId: target.messageThreadId,
                chatType: target.chatType === "unknown" ? undefined : target.chatType,
              };
            },
          },
          outbound: telegramOutboundForTest,
        }),
        pluginId: "telegram",
        source: "test",
      },
      {
        plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutboundForTest }),
        pluginId: "signal",
        source: "test",
      },
    ]),
  );
}
