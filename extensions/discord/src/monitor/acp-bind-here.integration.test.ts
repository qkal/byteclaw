import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { __testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";

const baseCfg = {
  acp: {
    backend: "acpx",
    dispatch: {
      enabled: true,
    },
    enabled: true,
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
      },
    },
  },
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
} satisfies OpenClawConfig;

function createDmClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.DM,
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

function createInMemoryDiscordBindingAdapter() {
  const bindings: SessionBindingRecord[] = [];

  const bind = async (input: SessionBindingBindInput) => {
    const normalizedConversation = {
      ...input.conversation,
      parentConversationId:
        input.conversation.parentConversationId ??
        (input.placement === "current" ? input.conversation.conversationId : undefined),
    };
    const record = {
      bindingId: `discord:default:${normalizedConversation.conversationId}`,
      boundAt: 1,
      conversation: normalizedConversation,
      status: "active",
      targetKind: input.targetKind,
      targetSessionKey: input.targetSessionKey,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    } satisfies SessionBindingRecord;
    const existingIndex = bindings.findIndex((entry) => entry.bindingId === record.bindingId);
    if (existingIndex !== -1) {
      bindings.splice(existingIndex, 1, record);
    } else {
      bindings.push(record);
    }
    return record;
  };

  registerSessionBindingAdapter({
    accountId: "default",
    bind,
    capabilities: {
      bindSupported: true,
      placements: ["current", "child"],
      unbindSupported: true,
    },
    channel: "discord",
    listBySession: (targetSessionKey) =>
      bindings.filter((entry) => entry.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (entry) =>
          entry.conversation.channel === ref.channel &&
          entry.conversation.accountId === ref.accountId &&
          entry.conversation.conversationId === ref.conversationId,
      ) ?? null,
    unbind: async ({ bindingId, targetSessionKey }) => {
      const removed = bindings.filter(
        (entry) =>
          (bindingId && entry.bindingId === bindingId) ||
          (targetSessionKey && entry.targetSessionKey === targetSessionKey),
      );
      for (const entry of removed) {
        const index = bindings.findIndex((candidate) => candidate.bindingId === entry.bindingId);
        if (index !== -1) {
          bindings.splice(index, 1);
        }
      }
      return removed;
    },
  });

  return { bindings };
}

describe("Discord ACP bind here end-to-end flow", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    loadConfigMock.mockReset().mockReturnValue(baseCfg);
  });

  it("routes the next Discord DM turn to an existing ACP session binding", async () => {
    const adapter = createInMemoryDiscordBindingAdapter();
    const binding = await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:user-1",
        parentConversationId: "user:user-1",
      },
      metadata: {
        agentId: "codex",
        boundBy: "user-1",
        label: "codex",
      },
      placement: "current",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:test-session",
    });

    expect(adapter.bindings).toHaveLength(1);
    expect(binding).toMatchObject({
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:user-1",
        parentConversationId: "user:user-1",
      },
      targetSessionKey: "agent:codex:acp:test-session",
    });
    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "default",
        channel: "discord",
        conversationId: "user:user-1",
      }),
    )?.toMatchObject({
      targetSessionKey: binding.targetSessionKey,
    });

    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "alice",
      },
      channelId: "dm-1",
      content: "follow up after bind",
      id: "m-followup-1",
    });

    const preflight = await preflightDiscordMessage({
      ...createDiscordPreflightArgs({
        botUserId: "bot-1",
        cfg: baseCfg,
        client: createDmClient("dm-1"),
        data: {
          author: message.author,
          channel_id: "dm-1",
          message,
        } as DiscordMessageEvent,
        discordConfig: {
          dmPolicy: "open",
        } as DiscordConfig,
      }),
    });

    expect(preflight).not.toBeNull();
    expect(preflight?.boundSessionKey).toBe(binding.targetSessionKey);
    expect(preflight?.route.sessionKey).toBe(binding.targetSessionKey);
    expect(preflight?.route.agentId).toBe("codex");
  });
});
