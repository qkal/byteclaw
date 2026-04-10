import { Type } from "@sinclair/typebox";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";

const handleDiscordMessageActionMock = vi.hoisted(() =>
  vi.fn(async () => ({ content: [], details: { ok: true } })),
);

const handleActionModule = await import("./actions/handle-action.js");
vi.spyOn(handleActionModule, "handleDiscordMessageAction").mockImplementation(
  handleDiscordMessageActionMock,
);
const { discordMessageActions } = await import("./channel-actions.js");

describe("discordMessageActions", () => {
  it("returns no tool actions when no token-sourced Discord accounts are enabled", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            enabled: true,
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery).toEqual({
      actions: [],
      capabilities: [],
      schema: null,
    });
  });

  it("describes enabled Discord actions for token-backed accounts", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            actions: {
              channels: false,
              permissions: true,
              polls: true,
              reactions: true,
              roles: false,
            },
            token: "Bot token-main",
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery?.capabilities).toEqual(["interactive", "components"]);
    expect(discovery?.schema).not.toBeNull();
    expect(discovery?.actions).toEqual(
      expect.arrayContaining(["send", "poll", "react", "reactions", "emoji-list", "permissions"]),
    );
    expect(discovery?.actions).not.toContain("channel-create");
    expect(discovery?.actions).not.toContain("role-add");
  });

  it("honors account-scoped action gates during discovery", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              actions: {
                polls: false,
                reactions: true,
              },
              token: "Bot token-work",
            },
          },
          actions: {
            polls: true,
            reactions: false,
          },
          token: "Bot token-main",
        },
      },
    } as OpenClawConfig;

    const defaultDiscovery = discordMessageActions.describeMessageTool?.({
      accountId: "default",
      cfg,
    });
    const workDiscovery = discordMessageActions.describeMessageTool?.({
      accountId: "work",
      cfg,
    });

    expect(defaultDiscovery?.actions).toEqual(expect.arrayContaining(["send", "poll"]));
    expect(defaultDiscovery?.actions).not.toContain("react");
    expect(workDiscovery?.actions).toEqual(
      expect.arrayContaining(["send", "react", "reactions", "emoji-list"]),
    );
    expect(workDiscovery?.actions).not.toContain("poll");
  });

  it("keeps components optional in the message tool schema", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            token: "Bot token-main",
          },
        },
      } as OpenClawConfig,
    });
    const schema = discovery?.schema;
    if (!schema || Array.isArray(schema)) {
      throw new Error("expected discord message-tool schema");
    }

    expect(Type.Object(schema.properties).required).toBeUndefined();
  });

  it("extracts send targets for message and thread reply actions", () => {
    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "sendMessage", to: "channel:123" },
      }),
    ).toEqual({ to: "channel:123" });

    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "threadReply", channelId: "987" },
      }),
    ).toEqual({ to: "channel:987" });

    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "threadReply", channelId: "   " },
      }),
    ).toBeNull();
  });

  it("delegates action handling to the Discord action handler", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot token-main",
        },
      },
    } as OpenClawConfig;
    const toolContext: ChannelMessageActionContext["toolContext"] = {
      currentChannelProvider: "discord",
    };
    const mediaLocalRoots = ["/tmp/media"];

    await discordMessageActions.handleAction?.({
      accountId: "ops",
      action: "send",
      cfg,
      channel: "discord",
      mediaLocalRoots,
      params: { message: "hello", to: "channel:123" },
      requesterSenderId: "user-1",
      toolContext,
    });

    expect(handleDiscordMessageActionMock).toHaveBeenCalledWith({
      accountId: "ops",
      action: "send",
      cfg,
      mediaLocalRoots,
      params: { message: "hello", to: "channel:123" },
      requesterSenderId: "user-1",
      toolContext,
    });
  });
});
