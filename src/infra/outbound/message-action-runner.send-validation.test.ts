import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  runDrySend,
  slackConfig,
  slackTestPlugin,
  telegramTestPlugin,
} from "./message-action-runner.test-helpers.js";

describe("runMessageAction send validation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: slackTestPlugin,
          pluginId: "slack",
          source: "test",
        },
        {
          plugin: telegramTestPlugin,
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runDrySend({
        actionParams: {
          channel: "slack",
          target: "#C12345678",
        },
        cfg: slackConfig,
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("allows send when only shared interactive payloads are provided", async () => {
    const result = await runDrySend({
      actionParams: {
        channel: "telegram",
        interactive: {
          blocks: [
            {
              buttons: [{ label: "Approve", value: "approve" }],
              type: "buttons",
            },
          ],
        },
        target: "123456",
      },
      cfg: {
        channels: {
          telegram: {
            botToken: "telegram-test",
          },
        },
      } as OpenClawConfig,
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only Slack blocks are provided", async () => {
    const result = await runDrySend({
      actionParams: {
        blocks: [{ type: "divider" }],
        channel: "slack",
        target: "#C12345678",
      },
      cfg: slackConfig,
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      actionParams: {
        channel: "slack",
        message: "hi",
        pollOption: ["Yes", "No"],
        pollQuestion: "Ready?",
        target: "#C12345678",
      },
      name: "structured poll params",
    },
    {
      actionParams: {
        channel: "slack",
        message: "hi",
        pollDurationSeconds: "60",
        pollPublic: "true",
        target: "#C12345678",
      },
      name: "string-encoded poll params",
    },
    {
      actionParams: {
        channel: "slack",
        message: "hi",
        poll_option: ["Yes", "No"],
        poll_public: "true",
        poll_question: "Ready?",
        target: "#C12345678",
      },
      name: "snake_case poll params",
    },
    {
      actionParams: {
        channel: "slack",
        message: "hi",
        pollDurationSeconds: -5,
        target: "#C12345678",
      },
      name: "negative poll duration params",
    },
  ])("rejects send actions that include $name", async ({ actionParams }) => {
    await expect(
      runDrySend({
        actionParams,
        cfg: slackConfig,
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });
});
