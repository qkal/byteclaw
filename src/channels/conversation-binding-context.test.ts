import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveConversationBindingContext } from "./conversation-binding-context.js";

describe("resolveConversationBindingContext", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("uses the plugin default account when accountId is omitted", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({
              config: {
                defaultAccountId: () => "work",
                listAccountIds: () => ["default", "work"],
              },
              id: "line",
              label: "LINE",
            }),
            bindings: {
              resolveCommandConversation: ({
                originatingTo,
                commandTo,
                fallbackTo,
              }: {
                originatingTo?: string;
                commandTo?: string;
                fallbackTo?: string;
              }) => {
                const conversationId = [originatingTo, commandTo, fallbackTo]
                  .map((candidate) => candidate?.trim().replace(/^line:/i, ""))
                  .map((candidate) => candidate?.replace(/^user:/i, ""))
                  .find((candidate) => candidate && candidate.length > 0);
                return conversationId ? { conversationId } : null;
              },
            },
          },
          pluginId: "line",
          source: "test",
        },
      ]),
    );

    expect(
      resolveConversationBindingContext({
        cfg: {} as OpenClawConfig,
        channel: "line",
        originatingTo: "line:user:U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      accountId: "work",
      channel: "line",
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
  });
});
