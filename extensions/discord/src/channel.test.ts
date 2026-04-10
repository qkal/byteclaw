import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import type { ResolvedDiscordAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import * as sendModule from "./send.js";
let discordPlugin: typeof import("./channel.js").discordPlugin;
let setDiscordRuntime: typeof import("./runtime.js").setDiscordRuntime;

const probeDiscordMock = vi.hoisted(() => vi.fn());
const monitorDiscordProviderMock = vi.hoisted(() => vi.fn());
const auditDiscordChannelPermissionsMock = vi.hoisted(() => vi.fn());
const collectDiscordAuditChannelIdsMock = vi.hoisted(() =>
  vi.fn(() => ({ channelIds: [], unresolvedChannels: 0 })),
);
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    sleepWithAbort: sleepWithAbortMock,
  };
});

vi.mock("./probe.js", () => ({
    probeDiscord: probeDiscordMock,
  }));

vi.mock("./monitor/provider.runtime.js", () => ({
    monitorDiscordProvider: monitorDiscordProviderMock,
  }));

vi.mock("./audit.js", () => ({
    auditDiscordChannelPermissions: auditDiscordChannelPermissionsMock,
    collectDiscordAuditChannelIds: collectDiscordAuditChannelIdsMock,
  }));

function createCfg(): OpenClawConfig {
  return {
    channels: {
      discord: {
        enabled: true,
        token: "discord-token",
      },
    },
  } as OpenClawConfig;
}

function resolveAccount(cfg: OpenClawConfig, accountId = "default"): ResolvedDiscordAccount {
  return discordPlugin.config.resolveAccount(cfg, accountId);
}

function startDiscordAccount(cfg: OpenClawConfig, accountId = "default") {
  return discordPlugin.gateway!.startAccount!(
    createStartAccountContext({
      account: resolveAccount(cfg, accountId),
      cfg,
    }),
  );
}

function installDiscordRuntime(discord: Record<string, unknown>) {
  setDiscordRuntime({
    channel: {
      discord,
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);
}

afterEach(() => {
  probeDiscordMock.mockReset();
  monitorDiscordProviderMock.mockReset();
  auditDiscordChannelPermissionsMock.mockReset();
  collectDiscordAuditChannelIdsMock.mockReset();
  collectDiscordAuditChannelIdsMock.mockReturnValue({
    channelIds: [],
    unresolvedChannels: 0,
  });
  sleepWithAbortMock.mockReset();
  sleepWithAbortMock.mockResolvedValue(undefined);
});

beforeEach(async () => {
  vi.useRealTimers();
  installDiscordRuntime({});
});

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ setDiscordRuntime } = await import("./runtime.js"));
});

describe("discordPlugin outbound", () => {
  it("avoids local require calls for bundled-only sibling modules", async () => {
    const source = await readFile(
      resolve(process.cwd(), "extensions/discord/src/channel.ts"),
      "utf8",
    );
    expect(source).not.toContain('require("./ui.js")');
    expect(source).not.toContain('require("./channel-actions.js")');
  });

  it("honors per-account replyToMode overrides", () => {
    const resolveReplyToMode = discordPlugin.threading?.resolveReplyToMode;
    if (!resolveReplyToMode) {
      throw new Error("Expected discordPlugin.threading.resolveReplyToMode to be defined");
    }

    const cfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              replyToMode: "first",
              token: "discord-token-work",
            },
          },
          replyToMode: "all",
          token: "discord-token",
        },
      },
    } as OpenClawConfig;

    expect(resolveReplyToMode({ accountId: "work", cfg })).toBe("first");
    expect(resolveReplyToMode({ accountId: "default", cfg })).toBe("all");
  });

  it("forwards full media send context to sendMessageDiscord", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m1" }));
    const mediaReadFile = vi.fn(async () => Buffer.from("media"));

    const result = await discordPlugin.outbound!.sendMedia!({
      accountId: "work",
      cfg: {} as OpenClawConfig,
      deps: {
        discord: sendMessageDiscord,
      },
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
      mediaUrl: "/tmp/image.png",
      replyToId: "reply-123",
      text: "hi",
      threadId: "thread-123",
      to: "channel:123",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:thread-123",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaReadFile,
        mediaUrl: "/tmp/image.png",
        replyTo: "reply-123",
      }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "m1" });
  });

  it("splits text and video into separate sends for attached outbound delivery", async () => {
    const sendMessageDiscord = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "text-1" })
      .mockResolvedValueOnce({ messageId: "video-1" });

    const result = await discordPlugin.outbound!.sendMedia!({
      accountId: "work",
      cfg: {} as OpenClawConfig,
      deps: {
        discord: sendMessageDiscord,
      },
      mediaUrl: "/tmp/molty.mp4",
      replyToId: "reply-123",
      text: "done - tiny cyber-lobster clip incoming",
      threadId: "thread-123",
      to: "channel:123",
    });

    expect(sendMessageDiscord).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscord).toHaveBeenNthCalledWith(
      1,
      "channel:thread-123",
      "done - tiny cyber-lobster clip incoming",
      expect.objectContaining({
        replyTo: "reply-123",
      }),
    );
    expect(sendMessageDiscord).toHaveBeenNthCalledWith(
      2,
      "channel:thread-123",
      "",
      expect.objectContaining({
        mediaUrl: "/tmp/molty.mp4",
      }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "video-1" });
  });

  it("threads poll sends through the thread target", async () => {
    const sendPollDiscord = vi.fn(async () => ({
      channelId: "channel:thread-123",
      messageId: "poll-1",
    }));
    const sendPollSpy = vi.spyOn(sendModule, "sendPollDiscord").mockImplementation(sendPollDiscord);
    try {
      const result = await discordPlugin.outbound!.sendPoll!({
        accountId: "work",
        cfg: {} as OpenClawConfig,
        poll: {
          options: ["molty", "molter"],
          question: "Best shell?",
        },
        threadId: "thread-123",
        to: "channel:123",
      });

      expect(sendPollDiscord).toHaveBeenCalledWith(
        "channel:thread-123",
        {
          options: ["molty", "molter"],
          question: "Best shell?",
        },
        expect.objectContaining({
          accountId: "work",
        }),
      );
      expect(result).toMatchObject({ channel: "discord", messageId: "poll-1" });
    } finally {
      sendPollSpy.mockRestore();
    }
  });

  it("uses direct Discord probe helpers for status probes", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    installDiscordRuntime({
      probeDiscord: runtimeProbeDiscord,
    });
    probeDiscordMock.mockResolvedValue({
      application: {
        intents: {
          guildMembers: "disabled",
          messageContent: "limited",
          presence: "disabled",
        },
      },
      bot: { username: "Bob" },
      elapsedMs: 1,
      ok: true,
    });

    const cfg = createCfg();
    const account = resolveAccount(cfg);

    await discordPlugin.status!.probeAccount!({
      account,
      cfg,
      timeoutMs: 5000,
    });

    expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 5000, {
      includeApplication: true,
    });
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
  });

  it("uses direct Discord startup helpers before monitoring", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    const runtimeMonitorDiscordProvider = vi.fn(async () => {
      throw new Error("runtime Discord monitor should not be used");
    });
    installDiscordRuntime({
      monitorDiscordProvider: runtimeMonitorDiscordProvider,
      probeDiscord: runtimeProbeDiscord,
    });
    probeDiscordMock.mockResolvedValue({
      application: {
        intents: {
          guildMembers: "disabled",
          messageContent: "limited",
          presence: "disabled",
        },
      },
      bot: { username: "Bob" },
      elapsedMs: 1,
      ok: true,
    });
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    await startDiscordAccount(cfg);

    expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 2500, {
      includeApplication: true,
    });
    expect(monitorDiscordProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        token: "discord-token",
      }),
    );
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
    expect(runtimeMonitorDiscordProvider).not.toHaveBeenCalled();
  });

  it("stagger starts later accounts in multi-bot setups", async () => {
    probeDiscordMock.mockResolvedValue({
      application: {
        intents: {
          guildMembers: "disabled",
          messageContent: "limited",
          presence: "disabled",
        },
      },
      bot: { username: "Cherry" },
      elapsedMs: 1,
      ok: true,
    });
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = {
      channels: {
        discord: {
          accounts: {
            // "alpha" sorts before "zeta" so alpha is index 0, zeta is index 1
            alpha: { enabled: true, token: "Bot alpha-token" },
            zeta: { enabled: true, token: "Bot zeta-token" },
          },
        },
      },
    } as OpenClawConfig;

    // First account (index 0) — no delay
    await startDiscordAccount(cfg, "alpha");
    expect(sleepWithAbortMock).not.toHaveBeenCalled();

    // Second account (index 1) — 10s delay
    await startDiscordAccount(cfg, "zeta");
    expect(sleepWithAbortMock).toHaveBeenCalledWith(10_000, expect.any(Object));
  });
});

describe("discordPlugin bindings", () => {
  it("derives DM current conversation ids from direct sender context", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      chatType: "direct",
      fallbackTo: "channel:dm-channel-1",
      from: "discord:123456789012345678",
      originatingTo: "channel:dm-channel-1",
    });

    expect(result).toEqual({
      conversationId: "user:123456789012345678",
    });
  });

  it("preserves user-prefixed current conversation ids for DM binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "user:123456789012345678",
    });

    expect(result).toEqual({
      conversationId: "user:123456789012345678",
    });
  });

  it("preserves channel-prefixed current conversation ids for channel binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:987654321098765432",
    });

    expect(result).toEqual({
      conversationId: "channel:987654321098765432",
    });
  });

  it("preserves channel-prefixed parent ids for thread binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:thread-42",
      threadId: "thread-42",
      threadParentId: "parent-9",
    });

    expect(result).toEqual({
      conversationId: "thread-42",
      parentConversationId: "channel:parent-9",
    });
  });
});

describe("discordPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes and mentions", () => {
    const resolveDmPolicy = discordPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        discord: {
          dm: { allowFrom: ["  discord:<@!123456789>  "], policy: "allowlist" },
          token: "discord-token",
        },
      },
    } as OpenClawConfig;

    const result = resolveDmPolicy({
      account: discordPlugin.config.resolveAccount(cfg, "default"),
      cfg,
    });
    if (!result) {
      throw new Error("discord resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  discord:<@!123456789>  "]);
    expect(result.normalizeEntry?.("  discord:<@!123456789>  ")).toBe("123456789");
    expect(result.normalizeEntry?.("  user:987654321  ")).toBe("987654321");
  });
});

describe("discordPlugin groups", () => {
  it("uses plugin-owned group policy resolvers", () => {
    const cfg = {
      channels: {
        discord: {
          guilds: {
            guild1: {
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                },
              },
              requireMention: false,
              tools: { allow: ["message.guild"] },
            },
          },
          token: "discord-test",
        },
      },
    } as OpenClawConfig;

    expect(
      discordPlugin.groups?.resolveRequireMention?.({
        cfg,
        groupId: "123",
        groupSpace: "guild1",
      }),
    ).toBe(true);
    expect(
      discordPlugin.groups?.resolveToolPolicy?.({
        cfg,
        groupId: "123",
        groupSpace: "guild1",
      }),
    ).toEqual({ allow: ["message.channel"] });
  });
});
