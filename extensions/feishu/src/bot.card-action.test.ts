import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import {
  type FeishuCardActionEvent,
  handleFeishuCardAction,
  resetProcessedFeishuCardActionTokensForTests,
} from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";

// Mock account resolution
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
  resolveFeishuRuntimeAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

// Mock bot.js to verify handleFeishuMessage call
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
}));

import { handleFeishuMessage } from "./bot.js";

describe("Feishu Card Action Handler", () => {
  const cfg: ClawdbotConfig = {};
  const runtime: RuntimeEnv = createRuntimeEnv();

  function createCardActionEvent(params: {
    token: string;
    actionValue: Record<string, unknown>;
    chatId?: string;
    openId?: string;
    userId?: string;
    unionId?: string;
  }): FeishuCardActionEvent {
    const openId = params.openId ?? "u123";
    const userId = params.userId ?? "uid1";
    return {
      action: {
        tag: "button",
        value: params.actionValue,
      },
      context: { chat_id: params.chatId ?? "chat1", open_id: openId, user_id: userId },
      operator: { open_id: openId, union_id: params.unionId ?? "un1", user_id: userId },
      token: params.token,
    };
  }

  function createStructuredQuickActionEvent(params: {
    token: string;
    action: string;
    command?: string;
    chatId?: string;
    chatType?: "group" | "p2p";
    operatorOpenId?: string;
    actionOpenId?: string;
  }): FeishuCardActionEvent {
    return createCardActionEvent({
      actionValue: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: params.action,
        ...(params.command ? { q: params.command } : {}),
        c: {
          e: Date.now() + 60_000,
          h: params.chatId ?? "chat1",
          t: params.chatType ?? "group",
          u: params.actionOpenId ?? params.operatorOpenId ?? "u123",
        },
      }),
      chatId: params.chatId,
      openId: params.operatorOpenId,
      token: params.token,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessedFeishuCardActionTokensForTests();
  });

  it("handles card action with text payload", async () => {
    const event: FeishuCardActionEvent = {
      action: { tag: "button", value: { text: "/ping" } },
      context: { chat_id: "chat1", open_id: "u123", user_id: "uid1" },
      operator: { open_id: "u123", union_id: "un1", user_id: "uid1" },
      token: "tok1",
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "chat1",
            content: '{"text":"/ping"}',
          }),
        }),
      }),
    );
  });

  it("handles card action with JSON object payload", async () => {
    const event: FeishuCardActionEvent = {
      action: { tag: "button", value: { key: "val" } },
      context: { chat_id: "", open_id: "u123", user_id: "uid1" },
      operator: { open_id: "u123", union_id: "un1", user_id: "uid1" },
      token: "tok2",
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "u123",
            content: '{"text":"{\\"key\\":\\"val\\"}"}', // Fallback to open_id
          }),
        }),
      }),
    );
  });

  it("routes quick command actions with operator and conversation context", async () => {
    const event = createStructuredQuickActionEvent({
      action: "feishu.quick_actions.help",
      command: "/help",
      token: "tok3",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "chat1",
            content: '{"text":"/help"}',
          }),
          sender: expect.objectContaining({
            sender_id: expect.objectContaining({
              open_id: "u123",
              union_id: "un1",
              user_id: "uid1",
            }),
          }),
        }),
      }),
    );
  });

  it("opens an approval card for metadata actions", async () => {
    const event: FeishuCardActionEvent = {
      action: {
        tag: "button",
        value: createFeishuCardInteractionEnvelope({
          a: FEISHU_APPROVAL_REQUEST_ACTION,
          c: {
            e: Date.now() + 60_000,
            h: "chat1",
            s: "agent:codex:feishu:chat:chat1",
            t: "group",
            u: "u123",
          },
          k: "meta",
          m: {
            command: "/new",
            prompt: "Start a fresh session?",
          },
        }),
      },
      context: { chat_id: "chat1", open_id: "u123", user_id: "uid1" },
      operator: { open_id: "u123", union_id: "un1", user_id: "uid1" },
      token: "tok4",
    };

    await handleFeishuCardAction({ accountId: "main", cfg, event, runtime });

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        card: expect.objectContaining({
          body: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "action",
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    value: expect.objectContaining({
                      c: expect.objectContaining({
                        u: "u123",
                        h: "chat1",
                        t: "group",
                        s: "agent:codex:feishu:chat:chat1",
                      }),
                    }),
                  }),
                ]),
              }),
            ]),
          }),
          config: expect.objectContaining({
            width_mode: "fill",
          }),
          header: expect.objectContaining({
            title: expect.objectContaining({ content: "Confirm action" }),
          }),
        }),
        to: "chat:chat1",
      }),
    );
    const firstSendArg = (sendCardFeishuMock.mock.calls as unknown[][]).at(0)?.[0] as
      | {
          card?: {
            config?: {
              width_mode?: string;
              wide_screen_mode?: boolean;
              enable_forward?: boolean;
            };
          };
        }
      | undefined;
    const sentCard = firstSendArg?.card;
    expect(sentCard).toBeDefined();
    expect(sentCard?.config?.wide_screen_mode).toBeUndefined();
    expect(sentCard?.config?.enable_forward).toBeUndefined();
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("runs approval confirmation through the normal message path", async () => {
    const event = createStructuredQuickActionEvent({
      action: FEISHU_APPROVAL_CONFIRM_ACTION,
      command: "/new",
      token: "tok5",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/new"}',
          }),
        }),
      }),
    );
  });

  it("safely rejects stale structured actions", async () => {
    const event = createCardActionEvent({
      actionValue: createFeishuCardInteractionEnvelope({
        a: "feishu.quick_actions.help",
        c: { e: Date.now() - 1, h: "chat1", t: "group", u: "u123" },
        k: "quick",
        q: "/help",
      }),
      token: "tok6",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("expired"),
        to: "chat:chat1",
      }),
    );
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("safely rejects wrong-user structured actions", async () => {
    const event = createStructuredQuickActionEvent({
      action: "feishu.quick_actions.help",
      actionOpenId: "u123",
      command: "/help",
      operatorOpenId: "u999",
      token: "tok7",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("different user"),
      }),
    );
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("sends a lightweight cancellation notice", async () => {
    const event: FeishuCardActionEvent = {
      action: {
        tag: "button",
        value: createFeishuCardInteractionEnvelope({
          a: FEISHU_APPROVAL_CANCEL_ACTION,
          c: { e: Date.now() + 60_000, h: "chat1", t: "group", u: "u123" },
          k: "button",
        }),
      },
      context: { chat_id: "chat1", open_id: "u123", user_id: "uid1" },
      operator: { open_id: "u123", union_id: "un1", user_id: "uid1" },
      token: "tok8",
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Cancelled.",
        to: "chat:chat1",
      }),
    );
  });

  it("preserves p2p callbacks for DM quick actions", async () => {
    const event = createStructuredQuickActionEvent({
      action: "feishu.quick_actions.help",
      chatId: "p2p-chat-1",
      chatType: "p2p",
      command: "/help",
      token: "tok9",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "p2p-chat-1",
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });

  it("drops duplicate structured callback tokens", async () => {
    const event = createStructuredQuickActionEvent({
      action: "feishu.quick_actions.help",
      command: "/help",
      token: "tok10",
    });

    await handleFeishuCardAction({ cfg, event, runtime });
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
  });

  it("releases a claimed token when dispatch fails so retries can succeed", async () => {
    const event = createStructuredQuickActionEvent({
      action: "feishu.quick_actions.help",
      command: "/help",
      token: "tok11",
    });
    vi.mocked(handleFeishuMessage)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined as never);

    await expect(handleFeishuCardAction({ cfg, event, runtime })).rejects.toThrow("transient");
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-flight token claimed while a slow dispatch is still running", async () => {
    vi.useFakeTimers();
    const event: FeishuCardActionEvent = {
      action: {
        tag: "button",
        value: createFeishuCardInteractionEnvelope({
          a: "feishu.quick_actions.help",
          c: { e: Date.now() + 60_000, h: "chat1", t: "group", u: "u123" },
          k: "quick",
          q: "/help",
        }),
      },
      context: { chat_id: "chat1", open_id: "u123", user_id: "uid1" },
      operator: { open_id: "u123", union_id: "un1", user_id: "uid1" },
      token: "tok12",
    };

    let resolveDispatch: (() => void) | undefined;
    vi.mocked(handleFeishuMessage).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }) as never,
    );

    const first = handleFeishuCardAction({ cfg, event, runtime });
    await vi.advanceTimersByTimeAsync(61_000);
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);

    resolveDispatch?.();
    await first;
    vi.useRealTimers();
  });
});
