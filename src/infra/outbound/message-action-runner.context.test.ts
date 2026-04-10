import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  directOutbound,
  runDryAction,
  runDrySend,
  slackConfig,
  slackTestPlugin,
  telegramTestPlugin,
  whatsappConfig,
  whatsappTestPlugin,
} from "./message-action-runner.test-helpers.js";

const imessageTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: { chatTypes: ["direct", "group"], media: true },
    docsPath: "/channels/imessage",
    id: "imessage",
    label: "iMessage",
  }),
  messaging: {
    normalizeTarget: (raw) => raw.trim() || undefined,
    targetResolver: {
      hint: "<handle|chat_id:ID>",
      looksLikeId: (raw) => raw.trim().length > 0,
    },
  },
  meta: {
    aliases: ["imsg"],
    blurb: "iMessage test stub.",
    docsPath: "/channels/imessage",
    id: "imessage",
    label: "iMessage",
    selectionLabel: "iMessage (imsg)",
  },
  outbound: directOutbound,
};

describe("runMessageAction context isolation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: slackTestPlugin,
          pluginId: "slack",
          source: "test",
        },
        {
          plugin: whatsappTestPlugin,
          pluginId: "whatsapp",
          source: "test",
        },
        {
          plugin: telegramTestPlugin,
          pluginId: "telegram",
          source: "test",
        },
        {
          plugin: imessageTestPlugin,
          pluginId: "imessage",
          source: "test",
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each([
    {
      actionParams: {
        channel: "slack",
        message: "hi",
        target: "#C12345678",
      },
      cfg: slackConfig,
      name: "allows send when target matches current channel",
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      actionParams: {
        channel: "slack",
        message: "hi",
        to: "#C12345678",
      },
      cfg: slackConfig,
      name: "accepts legacy to parameter for send",
    },
    {
      actionParams: {
        channel: "slack",
        message: "hi",
      },
      cfg: slackConfig,
      name: "defaults to current channel when target is omitted",
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      actionParams: {
        channel: "slack",
        media: "https://example.com/note.ogg",
        target: "#C12345678",
      },
      cfg: slackConfig,
      name: "allows media-only send when target matches current channel",
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      actionParams: {
        channel: "slack",
        message: "hi",
        pollAnonymous: false,
        pollMulti: false,
        pollPublic: false,
        target: "#C12345678",
      },
      cfg: slackConfig,
      name: "allows send when poll booleans are explicitly false",
      toolContext: { currentChannelId: "C12345678" },
    },
  ])("$name", async ({ cfg, actionParams, toolContext }) => {
    const result = await runDrySend({
      actionParams,
      cfg,
      ...(toolContext ? { toolContext } : {}),
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      expectedKind: "send",
      name: "send when target differs from current slack channel",
      run: () =>
        runDrySend({
          actionParams: {
            channel: "slack",
            message: "hi",
            target: "channel:C99999999",
          },
          cfg: slackConfig,
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
        }),
    },
    {
      expectedKind: "action",
      name: "thread-reply when channelId differs from current slack channel",
      run: () =>
        runDryAction({
          action: "thread-reply",
          actionParams: {
            channel: "slack",
            message: "hi",
            target: "C99999999",
          },
          cfg: slackConfig,
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
        }),
    },
  ])("blocks cross-context UI handoff for $name", async ({ run, expectedKind }) => {
    const result = await run();
    expect(result.kind).toBe(expectedKind);
  });

  it.each([
    {
      channel: "whatsapp",
      currentChannelId: "123@g.us",
      name: "whatsapp match",
      target: "123@g.us",
    },
    {
      channel: "imessage",
      currentChannelId: "imessage:+15551234567",
      name: "imessage match",
      target: "imessage:+15551234567",
    },
    {
      channel: "whatsapp",
      currentChannelId: "123@g.us",
      currentChannelProvider: "whatsapp",
      name: "whatsapp mismatch",
      target: "456@g.us",
    },
    {
      channel: "imessage",
      currentChannelId: "imessage:+15551234567",
      currentChannelProvider: "imessage",
      name: "imessage mismatch",
      target: "imessage:+15551230000",
    },
  ] as const)("$name", async (testCase) => {
    const result = await runDrySend({
      actionParams: {
        channel: testCase.channel,
        message: "hi",
        target: testCase.target,
      },
      cfg: whatsappConfig,
      toolContext: {
        currentChannelId: testCase.currentChannelId,
        ...(testCase.currentChannelProvider
          ? { currentChannelProvider: testCase.currentChannelProvider }
          : {}),
      },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      action: "send" as const,
      actionParams: {
        message: "hi",
      },
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-test",
            botToken: "xoxb-test",
          },
          telegram: {
            token: "tg-test",
          },
        },
      } as OpenClawConfig,
      expectedChannel: "slack",
      expectedKind: "send",
      name: "infers channel + target from tool context when missing",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    },
    {
      action: "send" as const,
      actionParams: {
        channel: "C12345678",
        message: "hi",
        target: "#C12345678",
      },
      cfg: slackConfig,
      expectedChannel: "slack",
      expectedKind: "send",
      name: "falls back to tool-context provider when channel param is an id",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    },
    {
      action: "broadcast" as const,
      actionParams: {
        channel: "C12345678",
        message: "hi",
        targets: ["channel:C12345678"],
      },
      cfg: slackConfig,
      expectedChannel: "slack",
      expectedKind: "broadcast",
      name: "falls back to tool-context provider for broadcast channel ids",
      toolContext: { currentChannelProvider: "slack" },
    },
  ])("$name", async ({ cfg, action, actionParams, toolContext, expectedKind, expectedChannel }) => {
    const result = await runDryAction({
      action,
      actionParams,
      cfg,
      toolContext,
    });

    expect(result.kind).toBe(expectedKind);
    expect(result.channel).toBe(expectedChannel);
  });

  it.each([
    {
      action: "send" as const,
      actionParams: {
        channel: "telegram",
        message: "hi",
        target: "@opsbot",
      },
      cfg: slackConfig,
      message: /Cross-context messaging denied/,
      name: "blocks cross-provider sends by default",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    },
    {
      action: "send" as const,
      actionParams: {
        channel: "slack",
        message: "hi",
        target: "channel:C99999999",
      },
      cfg: {
        ...slackConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      message: /Cross-context messaging denied/,
      name: "blocks same-provider cross-context when disabled",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    },
    {
      action: "upload-file" as const,
      actionParams: {
        channel: "slack",
        filePath: "/tmp/report.png",
        target: "channel:C99999999",
      },
      cfg: {
        ...slackConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      message: /Cross-context messaging denied/,
      name: "blocks same-provider cross-context uploads when disabled",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    },
    {
      action: "channel-info" as const,
      actionParams: {
        channel: "slack",
        channelId: "U12345678",
      },
      cfg: slackConfig,
      message: 'Channel id "U12345678" resolved to a user target.',
      name: "rejects channel ids that resolve to user targets",
    },
  ])("$name", async ({ action, cfg, actionParams, toolContext, message }) => {
    await expect(
      runDryAction({
        action,
        actionParams,
        cfg,
        toolContext,
      }),
    ).rejects.toThrow(message);
  });

  it.each([
    {
      name: "send",
      run: (abortSignal: AbortSignal) =>
        runDrySend({
          abortSignal,
          actionParams: {
            channel: "slack",
            message: "hi",
            target: "#C12345678",
          },
          cfg: slackConfig,
        }),
    },
    {
      name: "broadcast",
      run: (abortSignal: AbortSignal) =>
        runDryAction({
          abortSignal,
          action: "broadcast",
          actionParams: {
            channel: "slack",
            message: "hi",
            targets: ["channel:C12345678"],
          },
          cfg: slackConfig,
        }),
    },
  ])("aborts $name when abortSignal is already aborted", async ({ run }) => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
