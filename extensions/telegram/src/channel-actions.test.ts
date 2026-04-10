import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramMessageActionRuntime, telegramMessageActions } from "./channel-actions.js";

const handleTelegramActionMock = vi.hoisted(() => vi.fn());
const originalHandleTelegramAction = telegramMessageActionRuntime.handleTelegramAction;

describe("telegramMessageActions", () => {
  beforeEach(() => {
    handleTelegramActionMock.mockReset().mockResolvedValue({
      content: [],
      details: {},
      ok: true,
    });
    telegramMessageActionRuntime.handleTelegramAction = (...args) =>
      handleTelegramActionMock(...args);
  });

  afterEach(() => {
    telegramMessageActionRuntime.handleTelegramAction = originalHandleTelegramAction;
  });

  it("allows interactive-only sends", async () => {
    await telegramMessageActions.handleAction!({
      accountId: "default",
      action: "send",
      cfg: {} as never,
      mediaLocalRoots: [],
      params: {
        interactive: {
          blocks: [
            {
              buttons: [{ label: "Approve", value: "approve", style: "success" }],
              type: "buttons",
            },
          ],
        },
        to: "123456",
      },
    } as never);

    expect(handleTelegramActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        action: "sendMessage",
        interactive: {
          blocks: [
            {
              buttons: [{ label: "Approve", value: "approve", style: "success" }],
              type: "buttons",
            },
          ],
        },
        to: "123456",
      }),
      expect.anything(),
      expect.objectContaining({
        mediaLocalRoots: [],
      }),
    );
  });

  it("computes poll/topic action availability from config gates", () => {
    const cases = [
      {
        cfg: { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig,
        expectPoll: true,
        expectTopicEdit: true,
        name: "configured telegram enables poll",
      },
      {
        cfg: {
          channels: {
            telegram: {
              actions: { sendMessage: false },
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
        name: "sendMessage disabled hides poll",
      },
      {
        cfg: {
          channels: {
            telegram: {
              actions: { poll: false },
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
        name: "poll gate disabled hides poll",
      },
      {
        cfg: {
          channels: {
            telegram: {
              accounts: {
                pollOnly: {
                  actions: {
                    poll: true,
                    sendMessage: false,
                  },
                  botToken: "tok-poll",
                },
                senderOnly: {
                  actions: {
                    poll: false,
                    sendMessage: true,
                  },
                  botToken: "tok-send",
                },
              },
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
        name: "split account gates do not expose poll",
      },
    ] as const;

    for (const testCase of cases) {
      const actions =
        telegramMessageActions.describeMessageTool?.({
          cfg: testCase.cfg,
        })?.actions ?? [];
      if (testCase.expectPoll) {
        expect(actions, testCase.name).toContain("poll");
      } else {
        expect(actions, testCase.name).not.toContain("poll");
      }
      if (testCase.expectTopicEdit) {
        expect(actions, testCase.name).toContain("topic-edit");
      } else {
        expect(actions, testCase.name).not.toContain("topic-edit");
      }
    }
  });

  it("lists sticker actions only when enabled by config", () => {
    const cases = [
      {
        cfg: { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig,
        expectSticker: false,
        name: "default config",
      },
      {
        cfg: {
          channels: {
            telegram: {
              accounts: {
                media: { actions: { sticker: true }, botToken: "tok" },
              },
            },
          },
        } as OpenClawConfig,
        expectSticker: true,
        name: "per-account sticker enabled",
      },
      {
        cfg: {
          channels: {
            telegram: {
              accounts: {
                a: { botToken: "tok1" },
                b: { botToken: "tok2" },
              },
            },
          },
        } as OpenClawConfig,
        expectSticker: false,
        name: "all accounts omit sticker",
      },
    ] as const;

    for (const testCase of cases) {
      const actions =
        telegramMessageActions.describeMessageTool?.({
          cfg: testCase.cfg,
        })?.actions ?? [];
      if (testCase.expectSticker) {
        expect(actions, testCase.name).toEqual(
          expect.arrayContaining(["sticker", "sticker-search"]),
        );
      } else {
        expect(actions, testCase.name).not.toContain("sticker");
        expect(actions, testCase.name).not.toContain("sticker-search");
      }
    }
  });

  it("honors account-scoped action gates during discovery", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {
              actions: {
                poll: false,
                reactions: true,
              },
              botToken: "tok-work",
            },
          },
          actions: {
            poll: true,
            reactions: false,
          },
          botToken: "tok-default",
        },
      },
    } as OpenClawConfig;

    const defaultActions =
      telegramMessageActions.describeMessageTool?.({
        accountId: "default",
        cfg,
      })?.actions ?? [];
    const workActions =
      telegramMessageActions.describeMessageTool?.({
        accountId: "work",
        cfg,
      })?.actions ?? [];

    expect(defaultActions).toContain("poll");
    expect(defaultActions).not.toContain("react");
    expect(workActions).toContain("react");
    expect(workActions).not.toContain("poll");
  });

  it("normalizes reaction message identifiers before dispatch", async () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    const cases = [
      {
        expectedChannelField: "channelId",
        expectedChannelValue: "123",
        expectedMessageId: "456",
        name: "numeric channelId/messageId",
        params: {
          channelId: 123,
          emoji: "ok",
          messageId: 456,
        },
      },
      {
        expectedChannelField: "channelId",
        expectedChannelValue: "123",
        expectedMessageId: "456",
        name: "snake_case message_id",
        params: {
          channelId: 123,
          emoji: "ok",
          message_id: "456",
        },
      },
      {
        expectedChannelField: "chatId",
        expectedChannelValue: "123",
        expectedMessageId: "9001",
        name: "toolContext fallback",
        params: {
          chatId: "123",
          emoji: "ok",
        },
        toolContext: { currentMessageId: "9001" },
      },
      {
        expectedChannelField: "chatId",
        expectedChannelValue: "123",
        expectedMessageId: undefined,
        name: "missing messageId soft-falls through",
        params: {
          chatId: "123",
          emoji: "ok",
        },
      },
    ] as const;

    for (const testCase of cases) {
      handleTelegramActionMock.mockClear();
      await telegramMessageActions.handleAction?.({
        action: "react",
        cfg,
        channel: "telegram",
        params: testCase.params,
        toolContext: "toolContext" in testCase ? testCase.toolContext : undefined,
      });

      const call = handleTelegramActionMock.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call, testCase.name).toBeDefined();
      expect(call?.action, testCase.name).toBe("react");
      expect(String(call?.[testCase.expectedChannelField]), testCase.name).toBe(
        testCase.expectedChannelValue,
      );
      if (testCase.expectedMessageId === undefined) {
        expect(call?.messageId, testCase.name).toBeUndefined();
      } else {
        expect(String(call?.messageId), testCase.name).toBe(testCase.expectedMessageId);
      }
    }
  });
});
