import type { Client } from "@buape/carbon";
import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it } from "vitest";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import {
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAllowFrom,
  resolveDiscordRoleAllowed,
} from "./allow-list.js";
import {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway,
} from "./gateway-registry.js";
import { clearPresences, getPresence, presenceCacheSize, setPresence } from "./presence-cache.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan,
} from "./threading.js";

describe("resolveDiscordOwnerAllowFrom", () => {
  it("returns undefined when no allowlist is configured", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toBeUndefined();
  });

  it("skips wildcard matches for owner allowFrom", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["*"] } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toBeUndefined();
  });

  it("returns a matching user id entry", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["123"] } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toEqual(["123"]);
  });

  it("returns the normalized name slug for name matches only when enabled", () => {
    const defaultResult = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] } as DiscordChannelConfigResolved,
      sender: { id: "999", name: "Some User" },
    });
    expect(defaultResult).toBeUndefined();

    const enabledResult = resolveDiscordOwnerAllowFrom({
      allowNameMatching: true,
      channelConfig: { allowed: true, users: ["Some User"] } as DiscordChannelConfigResolved,
      sender: { id: "999", name: "Some User" },
    });

    expect(enabledResult).toEqual(["some-user"]);
  });
});

describe("resolveDiscordRoleAllowed", () => {
  it("allows when no role allowlist is configured", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: undefined,
      memberRoleIds: ["role-1"],
    });

    expect(allowed).toBe(true);
  });

  it("matches role IDs only", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["123"],
      memberRoleIds: ["123", "456"],
    });

    expect(allowed).toBe(true);
  });

  it("does not match non-ID role entries", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["Admin"],
      memberRoleIds: ["Admin"],
    });

    expect(allowed).toBe(false);
  });

  it("returns false when no matching role IDs", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["456"],
      memberRoleIds: ["123"],
    });

    expect(allowed).toBe(false);
  });
});

describe("resolveDiscordMemberAllowed", () => {
  it("allows when no user or role allowlists are configured", () => {
    const allowed = resolveDiscordMemberAllowed({
      memberRoleIds: [],
      roleAllowList: undefined,
      userAllowList: undefined,
      userId: "u1",
    });

    expect(allowed).toBe(true);
  });

  it("allows when user allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      memberRoleIds: ["999"],
      roleAllowList: ["456"],
      userAllowList: ["123"],
      userId: "123",
    });

    expect(allowed).toBe(true);
  });

  it("allows when role allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      memberRoleIds: ["456"],
      roleAllowList: ["456"],
      userAllowList: ["999"],
      userId: "123",
    });

    expect(allowed).toBe(true);
  });

  it("denies when user and role allowlists do not match", () => {
    const allowed = resolveDiscordMemberAllowed({
      memberRoleIds: ["role-1"],
      roleAllowList: ["role-2"],
      userAllowList: ["u2"],
      userId: "u1",
    });

    expect(allowed).toBe(false);
  });
});

describe("gateway-registry", () => {
  interface GatewayPlugin {
    isConnected: boolean;
  }

  function fakeGateway(props: Partial<GatewayPlugin> = {}): GatewayPlugin {
    return { isConnected: true, ...props };
  }

  beforeEach(() => {
    clearGateways();
  });

  it("stores and retrieves a gateway by account", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway as never);
    expect(getGateway("account-a")).toBe(gateway);
    expect(getGateway("account-b")).toBeUndefined();
  });

  it("uses collision-safe key when accountId is undefined", () => {
    const gateway = fakeGateway();
    registerGateway(undefined, gateway as never);
    expect(getGateway(undefined)).toBe(gateway);
    expect(getGateway("default")).toBeUndefined();
  });

  it("unregisters a gateway", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway as never);
    unregisterGateway("account-a");
    expect(getGateway("account-a")).toBeUndefined();
  });

  it("clears all gateways", () => {
    registerGateway("a", fakeGateway() as never);
    registerGateway("b", fakeGateway() as never);
    clearGateways();
    expect(getGateway("a")).toBeUndefined();
    expect(getGateway("b")).toBeUndefined();
  });

  it("overwrites existing entry for same account", () => {
    const gateway1 = fakeGateway({ isConnected: true });
    const gateway2 = fakeGateway({ isConnected: false });
    registerGateway("account-a", gateway1 as never);
    registerGateway("account-a", gateway2 as never);
    expect(getGateway("account-a")).toBe(gateway2);
  });
});

describe("presence-cache", () => {
  beforeEach(() => {
    clearPresences();
  });

  it("scopes presence entries by account", () => {
    const presenceA = { status: "online" } as GatewayPresenceUpdate;
    const presenceB = { status: "idle" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presenceA);
    setPresence("account-b", "user-1", presenceB);

    expect(getPresence("account-a", "user-1")).toBe(presenceA);
    expect(getPresence("account-b", "user-1")).toBe(presenceB);
    expect(getPresence("account-a", "user-2")).toBeUndefined();
  });

  it("clears presence per account", () => {
    const presence = { status: "dnd" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presence);
    setPresence("account-b", "user-2", presence);

    clearPresences("account-a");

    expect(getPresence("account-a", "user-1")).toBeUndefined();
    expect(getPresence("account-b", "user-2")).toBe(presence);
    expect(presenceCacheSize()).toBe(1);
  });
});

describe("resolveDiscordPresenceUpdate", () => {
  it("returns default online presence when no presence config provided", () => {
    expect(resolveDiscordPresenceUpdate({})).toEqual({
      activities: [],
      afk: false,
      since: null,
      status: "online",
    });
  });

  it("returns status-only presence when activity is omitted", () => {
    const presence = resolveDiscordPresenceUpdate({ status: "dnd" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("dnd");
    expect(presence?.activities).toEqual([]);
  });

  it("defaults to custom activity type when activity is set without type", () => {
    const presence = resolveDiscordPresenceUpdate({ activity: "Focus time" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("online");
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      name: "Custom Status",
      state: "Focus time",
      type: 4,
    });
  });

  it("includes streaming url when activityType is streaming", () => {
    const presence = resolveDiscordPresenceUpdate({
      activity: "Live",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    });
    expect(presence).not.toBeNull();
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      name: "Live",
      type: 1,
      url: "https://twitch.tv/openclaw",
    });
  });
});

describe("resolveDiscordAutoThreadContext", () => {
  it("returns null without a created thread and re-keys context when present", () => {
    const cases = [
      {
        createdThreadId: undefined,
        expectedNull: true,
        name: "no created thread",
      },
      {
        createdThreadId: "thread",
        expectedNull: false,
        name: "created thread",
      },
    ] as const;

    for (const testCase of cases) {
      const context = resolveDiscordAutoThreadContext({
        agentId: "agent",
        channel: "discord",
        createdThreadId: testCase.createdThreadId,
        messageChannelId: "parent",
      });

      if (testCase.expectedNull) {
        expect(context, testCase.name).toBeNull();
        continue;
      }

      expect(context, testCase.name).not.toBeNull();
      expect(context?.To, testCase.name).toBe("channel:thread");
      expect(context?.From, testCase.name).toBe("discord:channel:thread");
      expect(context?.OriginatingTo, testCase.name).toBe("channel:thread");
      expect(context?.SessionKey, testCase.name).toBe(
        buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { id: "thread", kind: "channel" },
        }),
      );
      expect(context?.ParentSessionKey, testCase.name).toBe(
        buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { id: "parent", kind: "channel" },
        }),
      );
    }
  });
});

describe("resolveDiscordReplyDeliveryPlan", () => {
  it("applies delivery targets and reply reference behavior across thread modes", () => {
    const cases = [
      {
        expectedDeliverTarget: "channel:parent",
        expectedReplyReferenceCalls: ["m1"],
        expectedReplyTarget: "channel:parent",
        input: {
          createdThreadId: null,
          messageId: "m1",
          replyTarget: "channel:parent" as const,
          replyToMode: "all" as const,
          threadChannel: null,
        },
        name: "original target with reply references",
      },
      {
        expectedDeliverTarget: "channel:thread",
        expectedReplyReferenceCalls: [undefined],
        expectedReplyTarget: "channel:thread",
        input: {
          createdThreadId: "thread",
          messageId: "m1",
          replyTarget: "channel:parent" as const,
          replyToMode: "all" as const,
          threadChannel: null,
        },
        name: "created thread disables reply references",
      },
      {
        expectedDeliverTarget: "channel:thread",
        expectedReplyReferenceCalls: [undefined],
        expectedReplyTarget: "channel:thread",
        input: {
          createdThreadId: null,
          messageId: "m1",
          replyTarget: "channel:thread" as const,
          replyToMode: "off" as const,
          threadChannel: { id: "thread" },
        },
        name: "thread + off mode",
      },
      {
        expectedDeliverTarget: "channel:thread",
        expectedReplyReferenceCalls: ["m1", "m1"],
        expectedReplyTarget: "channel:thread",
        input: {
          createdThreadId: null,
          messageId: "m1",
          replyTarget: "channel:thread" as const,
          replyToMode: "all" as const,
          threadChannel: { id: "thread" },
        },
        name: "thread + all mode",
      },
      {
        expectedDeliverTarget: "channel:thread",
        expectedReplyReferenceCalls: ["m1", undefined],
        expectedReplyTarget: "channel:thread",
        input: {
          createdThreadId: null,
          messageId: "m1",
          replyTarget: "channel:thread" as const,
          replyToMode: "first" as const,
          threadChannel: { id: "thread" },
        },
        name: "thread + first mode",
      },
    ] as const;

    for (const testCase of cases) {
      const plan = resolveDiscordReplyDeliveryPlan(testCase.input);
      expect(plan.deliverTarget, testCase.name).toBe(testCase.expectedDeliverTarget);
      expect(plan.replyTarget, testCase.name).toBe(testCase.expectedReplyTarget);
      for (const expected of testCase.expectedReplyReferenceCalls) {
        expect(plan.replyReference.use(), testCase.name).toBe(expected);
      }
    }
  });
});

describe("maybeCreateDiscordAutoThread", () => {
  function createAutoThreadParams(client: Client) {
    return {
      baseText: "hello",
      channelConfig: {
        autoThread: true,
      } as unknown as DiscordChannelConfigResolved,
      client,
      combinedBody: "hello",
      isGuildMessage: true,
      message: {
        channelId: "parent",
        id: "m1",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      threadChannel: null,
    };
  }

  it("handles create-thread failures with and without an existing thread", async () => {
    const cases = [
      {
        expected: "existing-thread",
        getResponse: { thread: { id: "existing-thread" } },
        name: "race condition returns existing thread",
        postError: "A thread has already been created on this message",
      },
      {
        expected: undefined,
        getResponse: { thread: null },
        name: "other error returns undefined",
        postError: "Some other error",
      },
    ] as const;

    for (const testCase of cases) {
      const client = {
        rest: {
          get: async () => testCase.getResponse,
          post: async () => {
            throw new Error(testCase.postError);
          },
        },
      } as unknown as Client;

      const result = await maybeCreateDiscordAutoThread(createAutoThreadParams(client));
      expect(result, testCase.name).toBe(testCase.expected);
    }
  });
});

describe("resolveDiscordAutoThreadReplyPlan", () => {
  function createAutoThreadPlanParams(overrides?: {
    client?: Client;
    channelConfig?: DiscordChannelConfigResolved;
    threadChannel?: { id: string } | null;
  }) {
    return {
      agentId: "agent",
      baseText: "hello",
      channel: "discord" as const,
      channelConfig:
        overrides?.channelConfig ??
        ({ autoThread: true } as unknown as DiscordChannelConfigResolved),
      client:
        overrides?.client ??
        ({ rest: { post: async () => ({ id: "thread" }) } } as unknown as Client),
      combinedBody: "hello",
      isGuildMessage: true,
      message: {
        channelId: "parent",
        id: "m1",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      replyToMode: "all" as const,
      threadChannel: overrides?.threadChannel ?? null,
    };
  }

  it("applies auto-thread reply planning across created, existing, and disabled modes", async () => {
    const cases = [
      {
        expectedDeliverTarget: "channel:thread",
        expectedReplyReference: undefined,
        expectedSessionKey: buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { id: "thread", kind: "channel" },
        }),
        name: "created thread",
        params: undefined,
      },
      {
        expectedDeliverTarget: "channel:thread",
        expectedReplyReference: "m1",
        expectedSessionKey: null,
        name: "existing thread channel",
        params: {
          threadChannel: { id: "thread" },
        },
      },
      {
        expectedDeliverTarget: "channel:parent",
        expectedReplyReference: "m1",
        expectedSessionKey: null,
        name: "autoThread disabled",
        params: {
          channelConfig: { autoThread: false } as unknown as DiscordChannelConfigResolved,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const plan = await resolveDiscordAutoThreadReplyPlan(
        createAutoThreadPlanParams(testCase.params),
      );
      expect(plan.deliverTarget, testCase.name).toBe(testCase.expectedDeliverTarget);
      expect(plan.replyReference.use(), testCase.name).toBe(testCase.expectedReplyReference);
      if (testCase.expectedSessionKey == null) {
        expect(plan.autoThreadContext, testCase.name).toBeNull();
      } else {
        expect(plan.autoThreadContext?.SessionKey, testCase.name).toBe(testCase.expectedSessionKey);
      }
    }
  });
});
