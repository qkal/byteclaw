import { ChannelType, type Guild } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { typedCases } from "../../../test/helpers/plugins/typed-cases.js";
import {
  type DiscordGuildEntryResolved,
  allowListMatches,
  buildDiscordMediaPayload,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  registerDiscordListener,
  resolveDiscordChannelConfig,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordReplyTarget,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
  sanitizeDiscordThreadName,
  shouldEmitDiscordReactionNotification,
} from "./monitor.js";
type DiscordReactionEvent = Parameters<
  import("./monitor/listeners.js").DiscordReactionListener["handle"]
>[0];
type DiscordReactionClient = Parameters<
  import("./monitor/listeners.js").DiscordReactionListener["handle"]
>[1];

const readAllowFromStoreMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
}));

const fakeGuild = (id: string, name: string) => ({ id, name }) as Guild;

const makeEntries = (
  entries: Record<string, Partial<DiscordGuildEntryResolved>>,
): Record<string, DiscordGuildEntryResolved> => {
  const out: Record<string, DiscordGuildEntryResolved> = {};
  for (const [key, value] of Object.entries(entries)) {
    out[key] = {
      channels: value.channels,
      reactionNotifications: value.reactionNotifications,
      requireMention: value.requireMention,
      roles: value.roles,
      slug: value.slug,
      users: value.users,
    };
  }
  return out;
};

function createAutoThreadMentionContext() {
  const guildInfo: DiscordGuildEntryResolved = {
    channels: {
      general: { autoThread: true, enabled: true },
    },
    requireMention: true,
  };
  const channelConfig = resolveDiscordChannelConfig({
    channelId: "1",
    channelName: "General",
    channelSlug: "general",
    guildInfo,
  });
  return { channelConfig, guildInfo };
}

beforeEach(() => {
  vi.useRealTimers();
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
});

describe("registerDiscordListener", () => {
  class FakeListener {}

  it("dedupes listeners by constructor", () => {
    const listeners: object[] = [];

    expect(registerDiscordListener(listeners, new FakeListener())).toBe(true);
    expect(registerDiscordListener(listeners, new FakeListener())).toBe(false);
    expect(listeners).toHaveLength(1);
  });
});

describe("DiscordMessageListener", () => {
  function createDeferred() {
    let resolve: (() => void) | null = null;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return {
      promise,
      resolve: () => {
        if (typeof resolve === "function") {
          (resolve as () => void)();
        }
      },
    };
  }

  async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("returns immediately while handler continues in background", async () => {
    let handlerResolved = false;
    const deferred = createDeferred();
    const handler = vi.fn(async () => {
      await deferred.promise;
      handlerResolved = true;
    });
    const listener = new DiscordMessageListener(handler);

    const handlePromise = listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("@buape/carbon").Client,
    );

    // Handle() returns immediately while the background queue starts on the next tick.
    await expect(handlePromise).resolves.toBeUndefined();
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledOnce();
    expect(handlerResolved).toBe(false);

    // Release and let background handler finish.
    deferred.resolve();
    await Promise.resolve();
    expect(handlerResolved).toBe(true);
  });

  it("dispatches subsequent events concurrently without blocking on prior handler", async () => {
    const first = createDeferred();
    const second = createDeferred();
    let runCount = 0;
    const handler = vi.fn(async () => {
      runCount += 1;
      if (runCount === 1) {
        await first.promise;
        return;
      }
      await second.promise;
    });
    const listener = new DiscordMessageListener(handler);

    await expect(
      listener.handle(
        {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
        {} as unknown as import("@buape/carbon").Client,
      ),
    ).resolves.toBeUndefined();
    await expect(
      listener.handle(
        {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
        {} as unknown as import("@buape/carbon").Client,
      ),
    ).resolves.toBeUndefined();

    // Both handlers are dispatched concurrently (fire-and-forget).
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);

    first.resolve();
    second.resolve();
    await Promise.resolve();
  });

  it("logs handler failures", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >;
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const listener = new DiscordMessageListener(handler, logger);

    await listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("@buape/carbon").Client,
    );
    await flushAsyncWork();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("discord handler failed"));
  });

  it("does not apply its own slow-listener logging (owned by inbound worker)", async () => {
    const deferred = createDeferred();
    const handler = vi.fn(() => deferred.promise);
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >;
    const listener = new DiscordMessageListener(handler, logger);

    const handlePromise = listener.handle(
      {} as unknown as import("./monitor/listeners.js").DiscordMessageEvent,
      {} as unknown as import("@buape/carbon").Client,
    );
    await expect(handlePromise).resolves.toBeUndefined();

    deferred.resolve();
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledOnce();
    // The listener no longer wraps handlers with slow-listener logging;
    // That responsibility moved to the inbound worker.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("discord allowlist helpers", () => {
  it("normalizes slugs", () => {
    expect(normalizeDiscordSlug("Friends of OpenClaw")).toBe("friends-of-openclaw");
    expect(normalizeDiscordSlug("#General")).toBe("general");
    expect(normalizeDiscordSlug("Dev__Chat")).toBe("dev-chat");
  });

  it("matches ids by default and names only when enabled", () => {
    const allow = normalizeDiscordAllowList(
      ["123", "steipete", "Friends of OpenClaw"],
      ["discord:", "user:", "guild:", "channel:"],
    );
    expect(allow).not.toBeNull();
    if (!allow) {
      throw new Error("Expected allow list to be normalized");
    }
    expect(allowListMatches(allow, { id: "123" })).toBe(true);
    expect(allowListMatches(allow, { name: "steipete" })).toBe(false);
    expect(allowListMatches(allow, { name: "friends-of-openclaw" })).toBe(false);
    expect(allowListMatches(allow, { name: "steipete" }, { allowNameMatching: true })).toBe(true);
    expect(
      allowListMatches(allow, { name: "friends-of-openclaw" }, { allowNameMatching: true }),
    ).toBe(true);
    expect(allowListMatches(allow, { name: "other" })).toBe(false);
  });

  it("matches pk-prefixed allowlist entries", () => {
    const allow = normalizeDiscordAllowList(["pk:member-123"], ["discord:", "user:", "pk:"]);
    expect(allow).not.toBeNull();
    if (!allow) {
      throw new Error("Expected allow list to be normalized");
    }
    expect(allowListMatches(allow, { id: "member-123" })).toBe(true);
    expect(allowListMatches(allow, { id: "member-999" })).toBe(false);
  });
});

describe("discord guild/channel resolution", () => {
  it("resolves guild entry by id", () => {
    const guildEntries = makeEntries({
      "123": { slug: "friends-of-openclaw" },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of OpenClaw"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-openclaw");
  });

  it("resolves guild entry by raw guild id when guild object is missing", () => {
    const guildEntries = makeEntries({
      "123": { slug: "friends-of-openclaw" },
    });
    const resolved = resolveDiscordGuildEntry({
      guildEntries,
      guildId: "123",
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-openclaw");
  });

  it("resolves guild entry by slug key", () => {
    const guildEntries = makeEntries({
      "friends-of-openclaw": { slug: "friends-of-openclaw" },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of OpenClaw"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.slug).toBe("friends-of-openclaw");
  });

  it("falls back to wildcard guild entry", () => {
    const guildEntries = makeEntries({
      "*": { requireMention: false },
    });
    const resolved = resolveDiscordGuildEntry({
      guild: fakeGuild("123", "Friends of OpenClaw"),
      guildEntries,
    });
    expect(resolved?.id).toBe("123");
    expect(resolved?.requireMention).toBe(false);
  });

  it("resolves channel config by slug", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
        help: {
          autoThread: true,
          enabled: true,
          requireMention: true,
          skills: ["search"],
          systemPrompt: "Use short answers.",
          users: ["123"],
        },
      },
    };
    const channel = resolveDiscordChannelConfig({
      channelId: "456",
      channelName: "General",
      channelSlug: "general",
      guildInfo,
    });
    expect(channel?.allowed).toBe(true);
    expect(channel?.requireMention).toBeUndefined();

    const help = resolveDiscordChannelConfig({
      channelId: "789",
      channelName: "Help",
      channelSlug: "help",
      guildInfo,
    });
    expect(help?.allowed).toBe(true);
    expect(help?.requireMention).toBe(true);
    expect(help?.skills).toEqual(["search"]);
    expect(help?.enabled).toBe(true);
    expect(help?.users).toEqual(["123"]);
    expect(help?.systemPrompt).toBe("Use short answers.");
    expect(help?.autoThread).toBe(true);
  });

  it("denies channel when config present but no match", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
      },
    };
    const channel = resolveDiscordChannelConfig({
      channelId: "999",
      channelName: "random",
      channelSlug: "random",
      guildInfo,
    });
    expect(channel?.allowed).toBe(false);
  });

  it("treats empty channel config map as no channel allowlist", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {},
    };
    const channel = resolveDiscordChannelConfig({
      channelId: "999",
      channelName: "random",
      channelSlug: "random",
      guildInfo,
    });
    expect(channel).toBeNull();
  });

  it("inherits parent config for thread channels", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
        random: { enabled: false },
      },
    };
    const thread = resolveDiscordChannelConfigWithFallback({
      channelId: "thread-123",
      channelName: "topic",
      channelSlug: "topic",
      guildInfo,
      parentId: "999",
      parentName: "random",
      parentSlug: "random",
      scope: "thread",
    });
    expect(thread?.allowed).toBe(false);
  });

  it("does not match thread name/slug when resolving allowlists", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
        random: { enabled: false },
      },
    };
    const thread = resolveDiscordChannelConfigWithFallback({
      channelId: "thread-999",
      channelName: "general",
      channelSlug: "general",
      guildInfo,
      parentId: "999",
      parentName: "random",
      parentSlug: "random",
      scope: "thread",
    });
    expect(thread?.allowed).toBe(false);
  });

  it("applies wildcard channel config when no specific match", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        "*": { autoThread: true, enabled: true, requireMention: true },
        general: { enabled: true, requireMention: false },
      },
    };
    // Specific channel should NOT use wildcard
    const general = resolveDiscordChannelConfig({
      channelId: "123",
      channelName: "general",
      channelSlug: "general",
      guildInfo,
    });
    expect(general?.allowed).toBe(true);
    expect(general?.requireMention).toBe(false);
    expect(general?.autoThread).toBeUndefined();
    expect(general?.matchSource).toBe("direct");

    // Unknown channel should use wildcard
    const random = resolveDiscordChannelConfig({
      channelId: "999",
      channelName: "random",
      channelSlug: "random",
      guildInfo,
    });
    expect(random?.allowed).toBe(true);
    expect(random?.autoThread).toBe(true);
    expect(random?.requireMention).toBe(true);
    expect(random?.matchSource).toBe("wildcard");
  });

  it("falls back to wildcard when thread channel and parent are missing", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        "*": { enabled: true, requireMention: false },
      },
    };
    const thread = resolveDiscordChannelConfigWithFallback({
      channelId: "thread-123",
      channelName: "topic",
      channelSlug: "topic",
      guildInfo,
      parentId: "parent-999",
      parentName: "general",
      parentSlug: "general",
      scope: "thread",
    });
    expect(thread?.allowed).toBe(true);
    expect(thread?.matchKey).toBe("*");
    expect(thread?.matchSource).toBe("wildcard");
  });

  it("treats empty channel config map as no thread allowlist", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {},
    };
    const thread = resolveDiscordChannelConfigWithFallback({
      channelId: "thread-123",
      channelName: "topic",
      channelSlug: "topic",
      guildInfo,
      parentId: "parent-999",
      parentName: "general",
      parentSlug: "general",
      scope: "thread",
    });
    expect(thread).toBeNull();
  });
});

describe("discord mention gating", () => {
  it("requires mention by default", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        general: { enabled: true },
      },
      requireMention: true,
    };
    const channelConfig = resolveDiscordChannelConfig({
      channelId: "1",
      channelName: "General",
      channelSlug: "general",
      guildInfo,
    });
    expect(
      resolveDiscordShouldRequireMention({
        channelConfig,
        guildInfo,
        isGuildMessage: true,
        isThread: false,
      }),
    ).toBe(true);
  });

  it("applies autoThread mention rules based on thread ownership", () => {
    const cases = [
      { expected: false, name: "bot-owned thread", threadOwnerId: "bot123" },
      { expected: true, name: "user-owned thread", threadOwnerId: "user456" },
      { expected: true, name: "unknown thread owner", threadOwnerId: undefined },
    ] as const;

    for (const testCase of cases) {
      const { guildInfo, channelConfig } = createAutoThreadMentionContext();
      expect(
        resolveDiscordShouldRequireMention({
          botId: "bot123",
          channelConfig,
          guildInfo,
          isGuildMessage: true,
          isThread: true,
          threadOwnerId: testCase.threadOwnerId,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });

  it("inherits parent channel mention rules for threads", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      channels: {
        "parent-1": { enabled: true, requireMention: false },
      },
      requireMention: true,
    };
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      channelId: "thread-1",
      channelName: "topic",
      channelSlug: "topic",
      guildInfo,
      parentId: "parent-1",
      parentName: "Parent",
      parentSlug: "parent",
      scope: "thread",
    });
    expect(channelConfig?.matchSource).toBe("parent");
    expect(channelConfig?.matchKey).toBe("parent-1");
    expect(
      resolveDiscordShouldRequireMention({
        channelConfig,
        guildInfo,
        isGuildMessage: true,
        isThread: true,
      }),
    ).toBe(false);
  });
});

describe("discord groupPolicy gating", () => {
  it("applies open/disabled/allowlist policy rules", () => {
    const cases = [
      {
        expected: true,
        input: {
          channelAllowed: false,
          channelAllowlistConfigured: false,
          groupPolicy: "open" as const,
          guildAllowlisted: false,
        },
        name: "open policy always allows",
      },
      {
        expected: false,
        input: {
          channelAllowed: true,
          channelAllowlistConfigured: true,
          groupPolicy: "disabled" as const,
          guildAllowlisted: true,
        },
        name: "disabled policy always blocks",
      },
      {
        expected: false,
        input: {
          channelAllowed: true,
          channelAllowlistConfigured: false,
          groupPolicy: "allowlist" as const,
          guildAllowlisted: false,
        },
        name: "allowlist blocks when guild not allowlisted",
      },
      {
        expected: true,
        input: {
          channelAllowed: true,
          channelAllowlistConfigured: false,
          groupPolicy: "allowlist" as const,
          guildAllowlisted: true,
        },
        name: "allowlist allows when guild allowlisted and no channel allowlist",
      },
      {
        expected: true,
        input: {
          channelAllowed: true,
          channelAllowlistConfigured: true,
          groupPolicy: "allowlist" as const,
          guildAllowlisted: true,
        },
        name: "allowlist allows when channel is allowed",
      },
      {
        expected: false,
        input: {
          channelAllowed: false,
          channelAllowlistConfigured: true,
          groupPolicy: "allowlist" as const,
          guildAllowlisted: true,
        },
        name: "allowlist blocks when channel is not allowed",
      },
    ] as const;

    for (const testCase of cases) {
      expect(isDiscordGroupAllowedByPolicy(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("discord group DM gating", () => {
  it("allows all when no allowlist", () => {
    expect(
      resolveGroupDmAllow({
        channelId: "1",
        channelName: "dm",
        channelSlug: "dm",
        channels: undefined,
      }),
    ).toBe(true);
  });

  it("matches group DM allowlist", () => {
    expect(
      resolveGroupDmAllow({
        channelId: "1",
        channelName: "OpenClaw DM",
        channelSlug: "openclaw-dm",
        channels: ["openclaw-dm"],
      }),
    ).toBe(true);
    expect(
      resolveGroupDmAllow({
        channelId: "1",
        channelName: "Other",
        channelSlug: "other",
        channels: ["openclaw-dm"],
      }),
    ).toBe(false);
  });
});

describe("discord reply target selection", () => {
  it("handles off/first/all reply modes", () => {
    const cases = [
      { expected: undefined, hasReplied: false, name: "off mode", replyToMode: "off" as const },
      {
        expected: "123",
        hasReplied: false,
        name: "first mode before reply",
        replyToMode: "first" as const,
      },
      {
        expected: undefined,
        hasReplied: true,
        name: "first mode after reply",
        replyToMode: "first" as const,
      },
      {
        expected: "123",
        hasReplied: false,
        name: "all mode before reply",
        replyToMode: "all" as const,
      },
      {
        expected: "123",
        hasReplied: true,
        name: "all mode after reply",
        replyToMode: "all" as const,
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        resolveDiscordReplyTarget({
          hasReplied: testCase.hasReplied,
          replyToId: "123",
          replyToMode: testCase.replyToMode,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });
});

describe("discord autoThread name sanitization", () => {
  it("strips mentions and collapses whitespace", () => {
    const name = sanitizeDiscordThreadName("  <@123>  <@&456> <#789>  Help   here  ", "msg-1");
    expect(name).toBe("Help here");
  });

  it("falls back to thread + id when empty after cleaning", () => {
    const name = sanitizeDiscordThreadName("   <@123>", "abc");
    expect(name).toBe("Thread abc");
  });
});

describe("discord reaction notification gating", () => {
  it("applies mode-specific reaction notification rules", () => {
    const cases = typedCases<{
      name: string;
      input: Parameters<typeof shouldEmitDiscordReactionNotification>[0];
      expected: boolean;
    }>([
      {
        expected: true,
        input: {
          botId: "bot-1",
          messageAuthorId: "bot-1",
          mode: undefined,
          userId: "user-1",
        },
        name: "unset defaults to own (author is bot)",
      },
      {
        expected: false,
        input: {
          botId: "bot-1",
          messageAuthorId: "user-1",
          mode: undefined,
          userId: "user-2",
        },
        name: "unset defaults to own (author is not bot)",
      },
      {
        expected: false,
        input: {
          botId: "bot-1",
          messageAuthorId: "bot-1",
          mode: "off" as const,
          userId: "user-1",
        },
        name: "off mode",
      },
      {
        expected: true,
        input: {
          botId: "bot-1",
          messageAuthorId: "user-1",
          mode: "all" as const,
          userId: "user-2",
        },
        name: "all mode",
      },
      {
        expected: false,
        input: {
          botId: "bot-1",
          guildInfo: { users: ["trusted-user"] },
          messageAuthorId: "user-1",
          mode: "all" as const,
          userId: "user-2",
        },
        name: "all mode blocks non-allowlisted guild member",
      },
      {
        expected: true,
        input: {
          botId: "bot-1",
          messageAuthorId: "bot-1",
          mode: "own" as const,
          userId: "user-2",
        },
        name: "own mode with bot-authored message",
      },
      {
        expected: false,
        input: {
          botId: "bot-1",
          messageAuthorId: "user-2",
          mode: "own" as const,
          userId: "user-3",
        },
        name: "own mode with non-bot-authored message",
      },
      {
        expected: false,
        input: {
          botId: "bot-1",
          guildInfo: { users: ["trusted-user"] },
          messageAuthorId: "bot-1",
          mode: "own" as const,
          userId: "user-3",
        },
        name: "own mode still blocks member outside users allowlist",
      },
      {
        expected: false,
        input: {
          allowlist: [] as string[],
          botId: "bot-1",
          messageAuthorId: "user-1",
          mode: "allowlist" as const,
          userId: "user-2",
        },
        name: "allowlist mode without match",
      },
      {
        expected: true,
        input: {
          botId: "bot-1",
          guildInfo: { users: ["123", "other"] },
          messageAuthorId: "user-1",
          mode: "allowlist" as const,
          userId: "123",
          userName: "steipete",
        },
        name: "allowlist mode with id match",
      },
      {
        expected: false,
        input: {
          botId: "bot-1",
          guildInfo: { users: ["trusted-user"] },
          messageAuthorId: "user-1",
          mode: "allowlist" as const,
          userId: "999",
          userName: "trusted-user",
        },
        name: "allowlist mode does not match usernames by default",
      },
      {
        expected: true,
        input: {
          allowNameMatching: true,
          botId: "bot-1",
          guildInfo: { users: ["trusted-user"] },
          messageAuthorId: "user-1",
          mode: "allowlist" as const,
          userId: "999",
          userName: "trusted-user",
        },
        name: "allowlist mode matches usernames when explicitly enabled",
      },
      {
        expected: true,
        input: {
          botId: "bot-1",
          guildInfo: { roles: ["role:trusted-role"] },
          memberRoleIds: ["trusted-role"],
          messageAuthorId: "user-1",
          mode: "allowlist" as const,
          userId: "999",
        },
        name: "allowlist mode matches allowed role",
      },
    ]);

    for (const testCase of cases) {
      expect(
        shouldEmitDiscordReactionNotification({
          ...testCase.input,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });
});

describe("discord media payload", () => {
  it("preserves attachment order for MediaPaths/MediaUrls", () => {
    const payload = buildDiscordMediaPayload([
      { contentType: "image/png", path: "/tmp/a.png" },
      { contentType: "image/png", path: "/tmp/b.png" },
      { contentType: "image/png", path: "/tmp/c.png" },
    ]);
    expect(payload.MediaPath).toBe("/tmp/a.png");
    expect(payload.MediaUrl).toBe("/tmp/a.png");
    expect(payload.MediaType).toBe("image/png");
    expect(payload.MediaPaths).toEqual(["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
    expect(payload.MediaUrls).toEqual(["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
  });
});

// --- DM reaction integration tests ---
// These test that handleDiscordReactionEvent (via DiscordReactionListener)
// Properly handles DM reactions instead of silently dropping them.

const { enqueueSystemEventSpy, resolveAgentRouteMock } = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn(),
  resolveAgentRouteMock: vi.fn((params: unknown) => ({
    accountId: "acc-1",
    agentId: "default",
    channel: "discord",
    lastRoutePolicy: "session" as const,
    mainSessionKey: "discord:acc-1:dm:user-1",
    matchedBy: "default" as const,
    sessionKey: "discord:acc-1:dm:user-1",
    ...(typeof params === "object" && params !== null ? { _params: params } : {}),
  })),
}));

const channelRuntimeModule = await import("openclaw/plugin-sdk/infra-runtime");
vi.spyOn(channelRuntimeModule, "enqueueSystemEvent").mockImplementation(enqueueSystemEventSpy);

const routingModule = await import("openclaw/plugin-sdk/routing");
vi.spyOn(routingModule, "resolveAgentRoute").mockImplementation(resolveAgentRouteMock);

const { DiscordMessageListener, DiscordReactionListener } = await import("./monitor/listeners.js");

function makeReactionEvent(overrides?: {
  guildId?: string;
  channelId?: string;
  userId?: string;
  messageId?: string;
  emojiName?: string;
  botAsAuthor?: boolean;
  messageAuthorId?: string;
  messageFetch?: ReturnType<typeof vi.fn>;
  guild?: { name?: string; id?: string };
  memberRoleIds?: string[];
}) {
  const userId = overrides?.userId ?? "user-1";
  const messageId = overrides?.messageId ?? "msg-1";
  const channelId = overrides?.channelId ?? "channel-1";
  const messageFetch =
    overrides?.messageFetch ??
    vi.fn(async () => ({
      author: {
        discriminator: "0",
        id: overrides?.messageAuthorId ?? (overrides?.botAsAuthor ? "bot-1" : "other-user"),
        username: overrides?.botAsAuthor ? "bot" : "otheruser",
      },
    }));
  return {
    channel_id: channelId,
    emoji: { id: null, name: overrides?.emojiName ?? "👍" },
    guild: overrides?.guild,
    guild_id: overrides?.guildId,
    message: {
      fetch: messageFetch,
    },
    message_id: messageId,
    rawMember: overrides?.memberRoleIds ? { roles: overrides.memberRoleIds } : undefined,
    user: {
      bot: false,
      discriminator: "0",
      id: userId,
      username: "testuser",
    },
  } as DiscordReactionEvent;
}

function makeReactionClient(options?: {
  channelType?: ChannelType;
  channelName?: string;
  parentId?: string;
  parentName?: string;
}) {
  const channelType = options?.channelType ?? ChannelType.DM;
  const channelName =
    options?.channelName ?? (channelType === ChannelType.DM ? undefined : "test-channel");
  const parentId = options?.parentId;
  const parentName = options?.parentName ?? "parent-channel";

  return {
    fetchChannel: vi.fn(async (channelId: string) => {
      if (parentId && channelId === parentId) {
        return { name: parentName, parentId: undefined, type: ChannelType.GuildText };
      }
      return { name: channelName, parentId, type: channelType };
    }),
  } as unknown as DiscordReactionClient;
}

function makeReactionListenerParams(overrides?: {
  botUserId?: string;
  dmEnabled?: boolean;
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  allowNameMatching?: boolean;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}) {
  return {
    accountId: "acc-1",
    allowFrom: overrides?.allowFrom ?? [],
    allowNameMatching: overrides?.allowNameMatching ?? false,
    botUserId: overrides?.botUserId ?? "bot-1",
    cfg: {} as ReturnType<typeof import("openclaw/plugin-sdk/config-runtime").loadConfig>,
    dmEnabled: overrides?.dmEnabled ?? true,
    dmPolicy: overrides?.dmPolicy ?? "open",
    groupDmChannels: overrides?.groupDmChannels ?? [],
    groupDmEnabled: overrides?.groupDmEnabled ?? true,
    groupPolicy: overrides?.groupPolicy ?? "open",
    guildEntries: overrides?.guildEntries,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >,
    runtime: {} as import("openclaw/plugin-sdk/runtime-env").RuntimeEnv,
  };
}

describe("discord DM reaction handling", () => {
  beforeEach(() => {
    enqueueSystemEventSpy.mockClear();
    resolveAgentRouteMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  });

  it("processes DM reactions with or without guild allowlists", async () => {
    const cases = [
      { guildEntries: undefined, name: "no guild allowlist" },
      {
        guildEntries: makeEntries({
          "guild-123": { slug: "guild-123" },
        }),
        name: "guild allowlist configured",
      },
    ] as const;

    for (const testCase of cases) {
      enqueueSystemEventSpy.mockClear();
      resolveAgentRouteMock.mockClear();

      const data = makeReactionEvent({ botAsAuthor: true });
      const client = makeReactionClient({ channelType: ChannelType.DM });
      const listener = new DiscordReactionListener(
        makeReactionListenerParams({ guildEntries: testCase.guildEntries }),
      );

      await listener.handle(data, client);

      expect(enqueueSystemEventSpy, testCase.name).toHaveBeenCalledOnce();
      const [text, opts] = enqueueSystemEventSpy.mock.calls[0];
      expect(text, testCase.name).toContain("Discord reaction added");
      expect(text, testCase.name).toContain("👍");
      expect(text, testCase.name).toContain("dm");
      expect(text, testCase.name).not.toContain("undefined");
      expect(opts.sessionKey, testCase.name).toBe("discord:acc-1:dm:user-1");
    }
  });

  it("blocks DM reactions when dmPolicy is disabled", async () => {
    const data = makeReactionEvent({ botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({ dmPolicy: "disabled" }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks DM reactions for unauthorized sender in allowlist mode", async () => {
    const data = makeReactionEvent({ botAsAuthor: true, userId: "user-1" });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        allowFrom: ["user:user-2"],
        dmPolicy: "allowlist",
      }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("allows DM reactions for authorized sender in allowlist mode", async () => {
    const data = makeReactionEvent({ botAsAuthor: true, userId: "user-1" });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        allowFrom: ["user:user-1"],
        dmPolicy: "allowlist",
      }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
  });

  it("blocks group DM reactions when group DMs are disabled", async () => {
    const data = makeReactionEvent({ botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.GroupDM });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({ groupDmEnabled: false }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks guild reactions when groupPolicy is disabled", async () => {
    const data = makeReactionEvent({
      botAsAuthor: true,
      guild: { id: "guild-123", name: "Guild" },
      guildId: "guild-123",
    });
    const client = makeReactionClient({ channelType: ChannelType.GuildText });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({ groupPolicy: "disabled" }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks guild reactions for sender outside users allowlist", async () => {
    const data = makeReactionEvent({
      botAsAuthor: true,
      guild: { id: "guild-123", name: "Test Guild" },
      guildId: "guild-123",
      userId: "attacker-user",
    });
    const client = makeReactionClient({ channelType: ChannelType.GuildText });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        guildEntries: makeEntries({
          "guild-123": {
            users: ["user:trusted-user"],
          },
        }),
      }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
    expect(resolveAgentRouteMock).not.toHaveBeenCalled();
  });

  it("allows guild reactions for sender in channel role allowlist override", async () => {
    resolveAgentRouteMock.mockReturnValueOnce({
      accountId: "acc-1",
      agentId: "default",
      channel: "discord",
      lastRoutePolicy: "session",
      mainSessionKey: "discord:acc-1:guild-123:channel-1",
      matchedBy: "default",
      sessionKey: "discord:acc-1:guild-123:channel-1",
    });

    const data = makeReactionEvent({
      botAsAuthor: true,
      guild: { id: "guild-123", name: "Test Guild" },
      guildId: "guild-123",
      memberRoleIds: ["trusted-role"],
      userId: "member-user",
    });
    const client = makeReactionClient({ channelType: ChannelType.GuildText });
    const listener = new DiscordReactionListener(
      makeReactionListenerParams({
        guildEntries: makeEntries({
          "guild-123": {
            channels: {
              "channel-1": {
                enabled: true,
                roles: ["role:trusted-role"],
              },
            },
            roles: ["role:blocked-role"],
          },
        }),
      }),
    );

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
    const [text] = enqueueSystemEventSpy.mock.calls[0];
    expect(text).toContain("Discord reaction added");
  });

  it("routes DM reactions with peer kind 'direct' and user id", async () => {
    enqueueSystemEventSpy.mockClear();
    resolveAgentRouteMock.mockClear();

    const data = makeReactionEvent({ botAsAuthor: true, userId: "user-42" });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionListener(makeReactionListenerParams());

    await listener.handle(data, client);

    expect(resolveAgentRouteMock).toHaveBeenCalledOnce();
    const routeArgs = (resolveAgentRouteMock.mock.calls[0]?.[0] ?? {}) as {
      peer?: unknown;
    };
    if (!routeArgs) {
      throw new Error("expected route arguments");
    }
    expect(routeArgs.peer).toEqual({ id: "user-42", kind: "direct" });
  });

  it("routes group DM reactions with peer kind 'group'", async () => {
    enqueueSystemEventSpy.mockClear();
    resolveAgentRouteMock.mockClear();

    const data = makeReactionEvent({ botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.GroupDM });
    const listener = new DiscordReactionListener(makeReactionListenerParams());

    await listener.handle(data, client);

    expect(resolveAgentRouteMock).toHaveBeenCalledOnce();
    const routeArgs = (resolveAgentRouteMock.mock.calls[0]?.[0] ?? {}) as {
      peer?: unknown;
    };
    if (!routeArgs) {
      throw new Error("expected route arguments");
    }
    expect(routeArgs.peer).toEqual({ id: "channel-1", kind: "group" });
  });
});

describe("discord reaction notification modes", () => {
  const guildId = "guild-900";
  const guild = fakeGuild(guildId, "Mode Guild");

  it("applies message-fetch behavior across notification modes and channel types", async () => {
    const cases = typedCases<{
      name: string;
      reactionNotifications: "off" | "all" | "allowlist" | "own";
      users: string[] | undefined;
      userId: string | undefined;
      channelType: ChannelType;
      channelId: string | undefined;
      parentId: string | undefined;
      messageAuthorId: string;
      expectedMessageFetchCalls: number;
      expectedEnqueueCalls: number;
    }>([
      {
        channelId: undefined,
        channelType: ChannelType.GuildText,
        expectedEnqueueCalls: 0,
        expectedMessageFetchCalls: 0,
        messageAuthorId: "other-user",
        name: "off mode",
        parentId: undefined,
        reactionNotifications: "off" as const,
        userId: undefined,
        users: undefined,
      },
      {
        channelId: undefined,
        channelType: ChannelType.GuildText,
        expectedEnqueueCalls: 1,
        expectedMessageFetchCalls: 0,
        messageAuthorId: "other-user",
        name: "all mode",
        parentId: undefined,
        reactionNotifications: "all" as const,
        userId: undefined,
        users: undefined,
      },
      {
        channelId: undefined,
        channelType: ChannelType.GuildText,
        expectedEnqueueCalls: 1,
        expectedMessageFetchCalls: 0,
        messageAuthorId: "other-user",
        name: "allowlist mode",
        parentId: undefined,
        reactionNotifications: "allowlist" as const,
        userId: "123",
        users: ["123"] as string[],
      },
      {
        channelId: undefined,
        channelType: ChannelType.GuildText,
        expectedEnqueueCalls: 1,
        expectedMessageFetchCalls: 1,
        messageAuthorId: "bot-1",
        name: "own mode",
        parentId: undefined,
        reactionNotifications: "own" as const,
        userId: undefined,
        users: undefined,
      },
      {
        channelId: "thread-1",
        channelType: ChannelType.PublicThread,
        expectedEnqueueCalls: 1,
        expectedMessageFetchCalls: 0,
        messageAuthorId: "other-user",
        name: "all mode thread channel",
        parentId: "parent-1",
        reactionNotifications: "all" as const,
        userId: undefined,
        users: undefined,
      },
    ]);

    for (const testCase of cases) {
      enqueueSystemEventSpy.mockClear();
      resolveAgentRouteMock.mockClear();

      const messageFetch = vi.fn(async () => ({
        author: { discriminator: "0", id: testCase.messageAuthorId, username: "author" },
      }));
      const data = makeReactionEvent({
        channelId: testCase.channelId,
        guild,
        guildId,
        messageFetch,
        userId: testCase.userId,
      });
      const client = makeReactionClient({
        channelType: testCase.channelType,
        parentId: testCase.parentId,
      });
      const guildEntries = makeEntries({
        [guildId]: {
          reactionNotifications: testCase.reactionNotifications,
          users: testCase.users ? [...testCase.users] : undefined,
        },
      });
      const listener = new DiscordReactionListener(makeReactionListenerParams({ guildEntries }));

      await listener.handle(data, client);

      expect(messageFetch, testCase.name).toHaveBeenCalledTimes(testCase.expectedMessageFetchCalls);
      expect(enqueueSystemEventSpy, testCase.name).toHaveBeenCalledTimes(
        testCase.expectedEnqueueCalls,
      );
    }
  });
});
