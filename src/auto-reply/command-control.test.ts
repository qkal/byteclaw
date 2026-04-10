import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { hasControlCommand, hasInlineCommandTokens } from "./command-detection.js";
import { listChatCommands } from "./commands-registry.js";
import { parseActivationCommand } from "./group-activation.js";
import { parseSendPolicyCommand } from "./send-policy.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

describe("resolveCommandAuthorization", () => {
  const formatAllowFrom = ({ allowFrom }: { allowFrom: (string | number)[] }) =>
    allowFrom.map((entry) => String(entry).trim()).filter(Boolean);

  function createAllowFromPlugin(
    id: string,
    resolveAllowFrom: () => (string | number)[] | undefined,
  ) {
    return {
      plugin: {
        ...createOutboundTestPlugin({
          id,
          outbound: { deliveryMode: "direct" },
        }),
        config: {
          formatAllowFrom,
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          resolveAllowFrom,
        },
      },
      pluginId: id,
      source: "test" as const,
    };
  }

  function createThrowingAllowFromPlugin(id: string, error: string) {
    return createAllowFromPlugin(id, () => {
      throw new Error(error);
    });
  }

  function registerAllowFromPlugins(...plugins: ReturnType<typeof createAllowFromPlugin>[]) {
    setActivePluginRegistry(createTestRegistry(plugins));
  }

  function resolveWhatsAppAuthorization(params: {
    from: string;
    senderId?: string;
    senderE164?: string;
    allowFrom: string[];
  }) {
    const cfg = {
      channels: { whatsapp: { allowFrom: params.allowFrom } },
    } as OpenClawConfig;
    const ctx = {
      From: params.from,
      Provider: "whatsapp",
      SenderE164: params.senderE164,
      SenderId: params.senderId,
      Surface: "whatsapp",
    } as MsgContext;
    return resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });
  }

  it.each([
    {
      allowFrom: ["+123"],
      expectedSenderId: "+123",
      from: "whatsapp:+999",
      name: "falls back from empty SenderId to SenderE164",
      senderE164: "+123",
      senderId: "",
    },
    {
      allowFrom: ["+123"],
      expectedSenderId: "+123",
      from: "whatsapp:+999",
      name: "falls back from whitespace SenderId to SenderE164",
      senderE164: "+123",
      senderId: "   ",
    },
    {
      allowFrom: ["+999"],
      expectedSenderId: "+999",
      from: "whatsapp:+999",
      name: "falls back to From when SenderId and SenderE164 are whitespace",
      senderE164: "   ",
      senderId: "   ",
    },
    {
      allowFrom: ["+123"],
      expectedSenderId: "+123",
      from: "whatsapp:+999",
      name: "falls back from un-normalizable SenderId to SenderE164",
      senderE164: "+123",
      senderId: "wat",
    },
    {
      allowFrom: ["+41796666864"],
      expectedSenderId: "+41796666864",
      from: "whatsapp:120363401234567890@g.us",
      name: "prefers SenderE164 when SenderId does not match allowFrom",
      senderE164: "+41796666864",
      senderId: "123@lid",
    },
  ])("$name", ({ from, senderId, senderE164, allowFrom, expectedSenderId }) => {
    const auth = resolveWhatsAppAuthorization({
      allowFrom,
      from,
      senderE164,
      senderId,
    });

    expect(auth.senderId).toBe(expectedSenderId);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("uses explicit owner allowlist when allowFrom is wildcard", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { ownerAllowFrom: ["whatsapp:+15551234567"] },
    } as OpenClawConfig;

    const ownerCtx = {
      From: "whatsapp:+15551234567",
      Provider: "whatsapp",
      SenderE164: "+15551234567",
      Surface: "whatsapp",
    } as MsgContext;
    const ownerAuth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: ownerCtx,
    });
    expect(ownerAuth.senderIsOwner).toBe(true);
    expect(ownerAuth.isAuthorizedSender).toBe(true);

    const otherCtx = {
      From: "whatsapp:+19995551234",
      Provider: "whatsapp",
      SenderE164: "+19995551234",
      Surface: "whatsapp",
    } as MsgContext;
    const otherAuth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: otherCtx,
    });
    expect(otherAuth.senderIsOwner).toBe(false);
    expect(otherAuth.isAuthorizedSender).toBe(false);
  });

  it("uses explicit owner allowlist when allowFrom is empty", () => {
    const cfg = {
      channels: { whatsapp: {} },
      commands: { ownerAllowFrom: ["whatsapp:+15551234567"] },
    } as OpenClawConfig;

    const ownerAuth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: {
        From: "whatsapp:+15551234567",
        Provider: "whatsapp",
        SenderE164: "+15551234567",
        Surface: "whatsapp",
      } as MsgContext,
    });
    expect(ownerAuth.senderIsOwner).toBe(true);
    expect(ownerAuth.isAuthorizedSender).toBe(true);

    const otherAuth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: {
        From: "whatsapp:+19995551234",
        Provider: "whatsapp",
        SenderE164: "+19995551234",
        Surface: "whatsapp",
      } as MsgContext,
    });
    expect(otherAuth.senderIsOwner).toBe(false);
    expect(otherAuth.isAuthorizedSender).toBe(false);
  });

  it("uses owner allowlist override from context when configured", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createOutboundTestPlugin({
            id: "discord",
            outbound: { deliveryMode: "direct" },
          }),
          pluginId: "discord",
          source: "test",
        },
      ]),
    );
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      From: "discord:123",
      OwnerAllowFrom: ["discord:123"],
      Provider: "discord",
      SenderId: "123",
      Surface: "discord",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.ownerList).toEqual(["123"]);
  });

  it("suppresses inherited owner status when the context forbids it", () => {
    const cfg = {
      channels: { telegram: { allowFrom: ["owner-123"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: {
        ForceSenderIsOwnerFalse: true,
        From: "owner-123",
        OriginatingChannel: "telegram",
        Provider: "exec-event",
        Surface: "telegram",
        To: "owner-123",
      } as MsgContext,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("does not infer a provider from channel allowlists for webchat command contexts", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+15551234567"] } },
    } as OpenClawConfig;

    const ctx = {
      OriginatingChannel: "webchat",
      Provider: "webchat",
      SenderId: "openclaw-control-ui",
      Surface: "webchat",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.providerId).toBeUndefined();
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("preserves external channel command auth in mixed webchat contexts", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+15551234567"] } },
      commands: { allowFrom: { whatsapp: ["+15551234567"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: {
        From: "whatsapp:+19995551234",
        OriginatingChannel: "whatsapp",
        Provider: "webchat",
        SenderE164: "+19995551234",
        Surface: "whatsapp",
      } as MsgContext,
    });

    expect(auth.providerId).toBe("whatsapp");
    expect(auth.isAuthorizedSender).toBe(false);
  });

  it("falls back to channel allowFrom when provider allowlist resolution throws", () => {
    registerAllowFromPlugins(
      createThrowingAllowFromPlugin("telegram", "channels.telegram.botToken: unresolved SecretRef"),
    );
    const cfg = {
      channels: { telegram: { allowFrom: ["123"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: {
        From: "telegram:123",
        Provider: "telegram",
        SenderId: "123",
        Surface: "telegram",
      } as MsgContext,
    });

    expect(auth.ownerList).toEqual(["123"]);
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  describe("commands.allowFrom", () => {
    const commandsAllowFromConfig = {
      channels: { whatsapp: { allowFrom: ["+different"] } },
      commands: {
        allowFrom: {
          "*": ["user123"],
        },
      },
    } as OpenClawConfig;

    function makeWhatsAppContext(senderId: string): MsgContext {
      return {
        From: `whatsapp:${senderId}`,
        Provider: "whatsapp",
        SenderId: senderId,
        Surface: "whatsapp",
      } as MsgContext;
    }

    function makeDiscordContext(senderId: string, fromOverride?: string): MsgContext {
      return {
        From: fromOverride ?? `discord:${senderId}`,
        Provider: "discord",
        SenderId: senderId,
        Surface: "discord",
      } as MsgContext;
    }

    function resolveWithCommandsAllowFrom(senderId: string, commandAuthorized: boolean) {
      return resolveCommandAuthorization({
        cfg: commandsAllowFromConfig,
        commandAuthorized,
        ctx: makeWhatsAppContext(senderId),
      });
    }

    it("uses commands.allowFrom global list when configured", () => {
      const authorizedAuth = resolveWithCommandsAllowFrom("user123", true);

      expect(authorizedAuth.isAuthorizedSender).toBe(true);

      const unauthorizedAuth = resolveWithCommandsAllowFrom("otheruser", true);

      expect(unauthorizedAuth.isAuthorizedSender).toBe(false);
    });

    it("ignores commandAuthorized when commands.allowFrom is configured", () => {
      const authorizedAuth = resolveWithCommandsAllowFrom("user123", false);

      expect(authorizedAuth.isAuthorizedSender).toBe(true);

      const unauthorizedAuth = resolveWithCommandsAllowFrom("otheruser", false);

      expect(unauthorizedAuth.isAuthorizedSender).toBe(false);
    });

    it("uses commands.allowFrom provider-specific list over global", () => {
      const cfg = {
        channels: { whatsapp: { allowFrom: ["*"] } },
        commands: {
          allowFrom: {
            "*": ["globaluser"],
            whatsapp: ["+15551234567"],
          },
        },
      } as OpenClawConfig;

      // User in global list but not in whatsapp-specific list
      const globalUserCtx = {
        From: "whatsapp:globaluser",
        Provider: "whatsapp",
        SenderId: "globaluser",
        Surface: "whatsapp",
      } as MsgContext;

      const globalAuth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: true,
        ctx: globalUserCtx,
      });

      // Provider-specific list overrides global, so globaluser is not authorized
      expect(globalAuth.isAuthorizedSender).toBe(false);

      // User in whatsapp-specific list
      const whatsappUserCtx = {
        From: "whatsapp:+15551234567",
        Provider: "whatsapp",
        SenderE164: "+15551234567",
        Surface: "whatsapp",
      } as MsgContext;

      const whatsappAuth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: true,
        ctx: whatsappUserCtx,
      });

      expect(whatsappAuth.isAuthorizedSender).toBe(true);
    });

    it("falls back to channel allowFrom when commands.allowFrom not set", () => {
      const cfg = {
        channels: { whatsapp: { allowFrom: ["+15551234567"] } },
      } as OpenClawConfig;

      const authorizedCtx = {
        From: "whatsapp:+15551234567",
        Provider: "whatsapp",
        SenderE164: "+15551234567",
        Surface: "whatsapp",
      } as MsgContext;

      const auth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: true,
        ctx: authorizedCtx,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("allows all senders when commands.allowFrom includes wildcard", () => {
      const cfg = {
        channels: { whatsapp: { allowFrom: ["+specific"] } },
        commands: {
          allowFrom: {
            "*": ["*"],
          },
        },
      } as OpenClawConfig;

      const anyUserCtx = {
        From: "whatsapp:anyuser",
        Provider: "whatsapp",
        SenderId: "anyuser",
        Surface: "whatsapp",
      } as MsgContext;

      const auth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: true,
        ctx: anyUserCtx,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("does not treat conversation ids in From as sender identities", () => {
      const cfg = {
        commands: {
          allowFrom: {
            discord: ["channel:123456789012345678"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: {
          ChatType: "channel",
          From: "discord:channel:123456789012345678",
          Provider: "discord",
          SenderId: "999999999999999999",
          Surface: "discord",
        } as MsgContext,
      });

      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("still falls back to From for direct messages when sender fields are absent", () => {
      const cfg = {
        commands: {
          allowFrom: {
            discord: ["123456789012345678"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: {
          ChatType: "direct",
          From: "discord:123456789012345678",
          Provider: "discord",
          SenderE164: " ",
          SenderId: " ",
          Surface: "discord",
        } as MsgContext,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("does not fall back to conversation-shaped From when chat type is missing", () => {
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["120363411111111111@g.us"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: {
          From: "120363411111111111@g.us",
          Provider: "whatsapp",
          SenderE164: " ",
          SenderId: " ",
          Surface: "whatsapp",
        } as MsgContext,
      });

      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("normalizes Discord commands.allowFrom prefixes and mentions", () => {
      const cfg = {
        commands: {
          allowFrom: {
            discord: ["user:123", "<@!456>", "pk:member-1"],
          },
        },
      } as OpenClawConfig;

      const userAuth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: makeDiscordContext("123"),
      });

      expect(userAuth.isAuthorizedSender).toBe(true);

      const mentionAuth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: makeDiscordContext("456"),
      });

      expect(mentionAuth.isAuthorizedSender).toBe(true);

      const pkAuth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: makeDiscordContext("member-1", "discord:999"),
      });

      expect(pkAuth.isAuthorizedSender).toBe(true);

      const deniedAuth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: makeDiscordContext("other"),
      });

      expect(deniedAuth.isAuthorizedSender).toBe(false);
    });
    it("fails closed when provider inference hits unresolved SecretRef allowlists", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin(
          "telegram",
          "channels.telegram.botToken: unresolved SecretRef",
        ),
      );

      const cfg = {
        channels: {
          telegram: {
            allowFrom: ["123"],
          },
        },
        commands: {
          allowFrom: {
            telegram: ["123"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        cfg,
        commandAuthorized: false,
        ctx: {
          SenderId: "123",
        } as MsgContext,
      });

      expect(auth.providerId).toBe("telegram");
      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("preserves provider resolution errors when inferred fallback allowFrom is empty", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin(
          "telegram",
          "channels.telegram.botToken: unresolved SecretRef",
        ),
      );

      const auth = resolveCommandAuthorization({
        cfg: {
          channels: {
            telegram: {},
          },
          commands: {
            allowFrom: {
              telegram: ["123"],
            },
          },
        } as OpenClawConfig,
        commandAuthorized: true,
        ctx: {
          SenderId: "123",
        } as MsgContext,
      });

      expect(auth.providerId).toBeUndefined();
      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("fails closed for global commands.allowFrom when inference errors drop every provider", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin("slack", "channels.slack.token: unresolved SecretRef"),
      );

      const auth = resolveCommandAuthorization({
        cfg: {
          channels: {
            slack: {},
          },
          commands: {
            allowFrom: {
              "*": ["123"],
            },
          },
        } as OpenClawConfig,
        commandAuthorized: false,
        ctx: {
          SenderId: "123",
        } as MsgContext,
      });

      expect(auth.providerId).toBeUndefined();
      expect(auth.isAuthorizedSender).toBe(false);
    });
    it("does not let an unrelated provider resolution error poison inferred commands.allowFrom", () => {
      registerAllowFromPlugins(
        createAllowFromPlugin("telegram", () => ["123"]),
        createThrowingAllowFromPlugin("slack", "channels.slack.token: unresolved SecretRef"),
      );

      const auth = resolveCommandAuthorization({
        cfg: {
          channels: {
            telegram: {
              allowFrom: ["123"],
            },
          },
          commands: {
            allowFrom: {
              telegram: ["123"],
            },
          },
        } as OpenClawConfig,
        commandAuthorized: false,
        ctx: {
          SenderId: "123",
        } as MsgContext,
      });

      expect(auth.providerId).toBe("telegram");
      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("preserves default-account allowFrom on SecretRef fallback", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin(
          "telegram",
          "channels.telegram.botToken: unresolved SecretRef",
        ),
      );

      const auth = resolveCommandAuthorization({
        cfg: {
          channels: {
            telegram: {
              accounts: {
                default: {
                  allowFrom: ["123"],
                },
              },
            },
          },
        } as OpenClawConfig,
        commandAuthorized: true,
        ctx: {
          Provider: "telegram",
          SenderId: "123",
          Surface: "telegram",
        } as MsgContext,
      });

      expect(auth.ownerList).toEqual(["123"]);
      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("treats undefined allowFrom as an open channel, not a resolution failure", () => {
      registerAllowFromPlugins(createAllowFromPlugin("discord", () => undefined));

      const auth = resolveCommandAuthorization({
        cfg: {
          channels: {
            discord: {},
          },
        } as OpenClawConfig,
        commandAuthorized: true,
        ctx: {
          Provider: "discord",
          SenderId: "123",
          Surface: "discord",
        } as MsgContext,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("does not log raw resolution messages from thrown allowFrom errors", () => {
      registerAllowFromPlugins(createThrowingAllowFromPlugin("telegram", "SECRET-TOKEN-123"));

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        resolveCommandAuthorization({
          cfg: {
            channels: {
              telegram: {
                allowFrom: ["123"],
              },
            },
          } as OpenClawConfig,
          commandAuthorized: true,
          ctx: {
            Provider: "telegram",
            SenderId: "123",
            Surface: "telegram",
          } as MsgContext,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("Error");
        expect(String(warn.mock.calls[0]?.[0] ?? "")).not.toContain("SECRET-TOKEN-123");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("grants senderIsOwner for internal channel with operator.admin scope", () => {
    const cfg = {} as OpenClawConfig;
    const ctx = {
      GatewayClientScopes: ["operator.admin"],
      Provider: "webchat",
      Surface: "webchat",
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });
    expect(auth.senderIsOwner).toBe(true);
  });

  it("does not grant senderIsOwner for internal channel without admin scope", () => {
    const cfg = {} as OpenClawConfig;
    const ctx = {
      GatewayClientScopes: ["operator.approvals"],
      Provider: "webchat",
      Surface: "webchat",
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });
    expect(auth.senderIsOwner).toBe(false);
  });

  it("does not grant senderIsOwner for external channel even with admin scope", () => {
    const cfg = {} as OpenClawConfig;
    const ctx = {
      From: "telegram:12345",
      GatewayClientScopes: ["operator.admin"],
      Provider: "telegram",
      Surface: "telegram",
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });
    expect(auth.senderIsOwner).toBe(false);
  });
});

describe("control command parsing", () => {
  it("requires slash for send policy", () => {
    expect(parseSendPolicyCommand("/send on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send: on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("/send:")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("send on")).toEqual({ hasCommand: false });
    expect(parseSendPolicyCommand("send")).toEqual({ hasCommand: false });
  });

  it("requires slash for activation", () => {
    expect(parseActivationCommand("/activation mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation: mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation:")).toEqual({
      hasCommand: true,
    });
    expect(parseActivationCommand("activation mention")).toEqual({
      hasCommand: false,
    });
  });

  it("treats bare commands as non-control", () => {
    expect(hasControlCommand("send")).toBe(false);
    expect(hasControlCommand("help")).toBe(false);
    expect(hasControlCommand("/commands")).toBe(true);
    expect(hasControlCommand("/commands:")).toBe(true);
    expect(hasControlCommand("commands")).toBe(false);
    expect(hasControlCommand("/status")).toBe(true);
    expect(hasControlCommand("/status:")).toBe(true);
    expect(hasControlCommand("status")).toBe(false);
    expect(hasControlCommand("usage")).toBe(false);

    for (const command of listChatCommands()) {
      for (const alias of command.textAliases) {
        expect(hasControlCommand(alias)).toBe(true);
        expect(hasControlCommand(`${alias}:`)).toBe(true);
      }
    }
    expect(hasControlCommand("/compact")).toBe(true);
    expect(hasControlCommand("/compact:")).toBe(true);
    expect(hasControlCommand("compact")).toBe(false);
  });

  it("respects disabled config/debug commands", () => {
    const cfg = { commands: { config: false, debug: false } };
    expect(hasControlCommand("/config show", cfg)).toBe(false);
    expect(hasControlCommand("/debug show", cfg)).toBe(false);
  });

  it("requires commands to be the full message", () => {
    expect(hasControlCommand("hello /status")).toBe(false);
    expect(hasControlCommand("/status please")).toBe(false);
    expect(hasControlCommand("prefix /send on")).toBe(false);
    expect(hasControlCommand("/send on")).toBe(true);
  });

  it("detects inline command tokens", () => {
    expect(hasInlineCommandTokens("hello /status")).toBe(true);
    expect(hasInlineCommandTokens("hey /think high")).toBe(true);
    expect(hasInlineCommandTokens("plain text")).toBe(false);
    expect(hasInlineCommandTokens("http://example.com/path")).toBe(false);
    expect(hasInlineCommandTokens("stop")).toBe(false);
  });

  it("ignores telegram commands addressed to other bots", () => {
    expect(
      hasControlCommand("/help@otherbot", undefined, {
        botUsername: "openclaw",
      }),
    ).toBe(false);
    expect(
      hasControlCommand("/help@openclaw", undefined, {
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it("detects commands wrapped in inbound metadata blocks", () => {
    const metaWrapped = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-abc","chat_id":"chat-123"}',
      "```",
      "",
      "/model spark",
    ].join("\n");
    expect(hasControlCommand(metaWrapped)).toBe(true);
  });

  it("detects /new command after metadata prefix", () => {
    const metaWrapped = [
      "Sender (untrusted metadata):",
      "```json",
      '{"name":"Alice","id":"user-1"}',
      "```",
      "",
      "/new spark",
    ].join("\n");
    expect(hasControlCommand(metaWrapped)).toBe(true);
  });

  it("detects /status command after timestamp + metadata prefix", () => {
    const metaWrapped = [
      "[Wed 2026-03-11 23:51 PDT] Conversation info (untrusted metadata):",
      "```json",
      '{"chat_id":"chat-123"}',
      "```",
      "",
      "/status",
    ].join("\n");
    expect(hasControlCommand(metaWrapped)).toBe(true);
  });
});
