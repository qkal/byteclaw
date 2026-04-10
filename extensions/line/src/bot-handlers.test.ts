import type { webhook } from "@line/bot-sdk";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineAccountConfig } from "./types.js";

type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;

// Avoid pulling in globals/pairing/media dependencies; this suite only asserts
// Allowlist/groupPolicy gating and message-context wiring.
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  buildMentionRegexes: () => [],
  matchesMentionPatterns: () => false,
  resolveInboundMentionDecision: (params: {
    facts?: {
      canDetectMention: boolean;
      wasMentioned: boolean;
      hasAnyMention?: boolean;
    };
    policy?: {
      isGroup: boolean;
      requireMention: boolean;
      allowTextCommands: boolean;
      hasControlCommand: boolean;
      commandAuthorized: boolean;
    };
    isGroup?: boolean;
    requireMention?: boolean;
    canDetectMention?: boolean;
    wasMentioned?: boolean;
    hasAnyMention?: boolean;
    allowTextCommands?: boolean;
    hasControlCommand?: boolean;
    commandAuthorized?: boolean;
  }) => {
    const facts =
      "facts" in params && params.facts
        ? params.facts
        : {
            canDetectMention: Boolean(params.canDetectMention),
            hasAnyMention: params.hasAnyMention,
            wasMentioned: Boolean(params.wasMentioned),
          };
    const policy =
      "policy" in params && params.policy
        ? params.policy
        : {
            allowTextCommands: Boolean(params.allowTextCommands),
            commandAuthorized: Boolean(params.commandAuthorized),
            hasControlCommand: Boolean(params.hasControlCommand),
            isGroup: Boolean(params.isGroup),
            requireMention: Boolean(params.requireMention),
          };
    return {
      effectiveWasMentioned:
        facts.wasMentioned ||
        (policy.allowTextCommands &&
          policy.hasControlCommand &&
          policy.commandAuthorized &&
          !facts.hasAnyMention),
      implicitMention: false,
      matchedImplicitMentionKinds: [],
      shouldBypassMention:
        policy.isGroup &&
        policy.requireMention &&
        !facts.wasMentioned &&
        !facts.hasAnyMention &&
        policy.allowTextCommands &&
        policy.hasControlCommand &&
        policy.commandAuthorized,
      shouldSkip:
        policy.isGroup &&
        policy.requireMention &&
        facts.canDetectMention &&
        !facts.wasMentioned &&
        !(
          policy.allowTextCommands &&
          policy.hasControlCommand &&
          policy.commandAuthorized &&
          !facts.hasAnyMention
        ),
    };
  },
}));
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer:
    ({ upsertPairingRequest }: { upsertPairingRequest: (args: unknown) => Promise<unknown> }) =>
    async ({ senderId, onCreated }: { senderId: string; onCreated?: () => void }) => {
      await upsertPairingRequest({ id: senderId, meta: {} });
      onCreated?.();
    },
}));
vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  hasControlCommand: (text: string) => text.trim().startsWith("!"),
  resolveControlCommandGate: ({
    hasControlCommand,
    authorizers,
  }: {
    hasControlCommand: boolean;
    authorizers: { configured: boolean; allowed: boolean }[];
  }) => ({
    commandAuthorized:
      hasControlCommand && authorizers.some((entry) => entry.allowed || !entry.configured),
  }),
}));
vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  resolveAllowlistProviderRuntimeGroupPolicy: ({
    groupPolicy,
    defaultGroupPolicy,
  }: {
    groupPolicy?: string;
    defaultGroupPolicy: string;
  }) => ({
    groupPolicy: groupPolicy ?? defaultGroupPolicy,
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: (cfg: { channels?: { line?: { groupPolicy?: string } } }) =>
    cfg.channels?.line?.groupPolicy ?? "open",
  warnMissingProviderGroupPolicyFallbackOnce: () => {},
}));
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (text: string) => text,
  logVerbose: () => {},
}));
vi.mock("openclaw/plugin-sdk/group-access", () => ({
  evaluateMatchedGroupAccessForPolicy: ({
    groupPolicy,
    hasMatchInput,
    allowlistConfigured,
    allowlistMatched,
  }: {
    groupPolicy: string;
    hasMatchInput: boolean;
    allowlistConfigured: boolean;
    allowlistMatched: boolean;
  }) => {
    if (groupPolicy === "disabled") {
      return { allowed: false, reason: "disabled" };
    }
    if (groupPolicy !== "allowlist") {
      return { allowed: true, reason: null };
    }
    if (!hasMatchInput) {
      return { allowed: false, reason: "missing_match_input" };
    }
    if (!allowlistConfigured) {
      return { allowed: false, reason: "empty_allowlist" };
    }
    if (!allowlistMatched) {
      return { allowed: false, reason: "not_allowlisted" };
    }
    return { allowed: true, reason: null };
  },
}));
vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
  clearHistoryEntriesIfEnabled: ({
    historyMap,
    historyKey,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
  }) => {
    historyMap.delete(historyKey);
  },
  recordPendingHistoryEntryIfEnabled: ({
    historyMap,
    historyKey,
    limit,
    entry,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
    limit: number;
    entry: HistoryEntry;
  }) => {
    const existing = historyMap.get(historyKey) ?? [];
    historyMap.set(historyKey, [...existing, entry].slice(-limit));
  },
}));
vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: () => ({ agentId: "default" }),
}));

const { readAllowFromStoreMock, upsertPairingRequestMock } = vi.hoisted(() => ({
  readAllowFromStoreMock: vi.fn(async () => [] as string[]),
  upsertPairingRequestMock: vi.fn(async () => ({ code: "CODE", created: true })),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readAllowFromStoreMock,
  resolvePairingIdLabel: () => "lineUserId",
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

vi.mock("./download.js", () => ({
  downloadLineMedia: async () => {
    throw new Error("downloadLineMedia should not be called from bot-handlers tests");
  },
}));

vi.mock("./send.js", () => ({
  pushMessageLine: async () => {
    throw new Error("pushMessageLine should not be called from bot-handlers tests");
  },
  replyMessageLine: async () => {
    throw new Error("replyMessageLine should not be called from bot-handlers tests");
  },
}));

const { buildLineMessageContextMock, buildLinePostbackContextMock } = vi.hoisted(() => ({
  buildLineMessageContextMock: vi.fn(async () => ({
    accountId: "default",
    ctxPayload: { From: "line:group:group-1" },
    isGroup: true,
    replyToken: "reply-token",
    route: { agentId: "default" },
  })),
  buildLinePostbackContextMock: vi.fn(async () => null as unknown),
}));

vi.mock("./bot-message-context.js", () => ({
  buildLineMessageContext: buildLineMessageContextMock,
  buildLinePostbackContext: buildLinePostbackContextMock,
  getLineSourceInfo: (source: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  }) => ({
    groupId: source.type === "group" ? source.groupId : undefined,
    isGroup: source.type === "group" || source.type === "room",
    roomId: source.type === "room" ? source.roomId : undefined,
    userId: source.userId,
  }),
}));

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;
let createLineWebhookReplayCache: typeof import("./bot-handlers.js").createLineWebhookReplayCache;
type LineWebhookContext = Parameters<typeof import("./bot-handlers.js").handleLineWebhookEvents>[1];

const createRuntime = () => ({ error: vi.fn(), exit: vi.fn(), log: vi.fn() });

function createReplayMessageEvent(params: {
  messageId: string;
  groupId: string;
  userId: string;
  webhookEventId: string;
  isRedelivery: boolean;
}) {
  return {
    deliveryContext: { isRedelivery: params.isRedelivery },
    message: { id: params.messageId, quoteToken: "quote-token", text: "hello", type: "text" },
    mode: "active",
    replyToken: "reply-token",
    source: { groupId: params.groupId, type: "group", userId: params.userId },
    timestamp: Date.now(),
    type: "message",
    webhookEventId: params.webhookEventId,
  } as MessageEvent;
}

function createTestMessageEvent(params: {
  message: MessageEvent["message"];
  source: MessageEvent["source"];
  webhookEventId: string;
  timestamp?: number;
  replyToken?: string;
  isRedelivery?: boolean;
}) {
  return {
    deliveryContext: { isRedelivery: params.isRedelivery ?? false },
    message: params.message,
    mode: "active",
    replyToken: params.replyToken ?? "reply-token",
    source: params.source,
    timestamp: params.timestamp ?? Date.now(),
    type: "message",
    webhookEventId: params.webhookEventId,
  } as MessageEvent;
}

function createLineWebhookTestContext(params: {
  processMessage: LineWebhookContext["processMessage"];
  groupPolicy?: LineAccountConfig["groupPolicy"];
  dmPolicy?: LineAccountConfig["dmPolicy"];
  requireMention?: boolean;
  groupHistories?: Map<string, HistoryEntry[]>;
  replayCache?: ReturnType<typeof createLineWebhookReplayCache>;
}): Parameters<typeof handleLineWebhookEvents>[1] {
  const lineConfig = {
    ...(params.groupPolicy ? { groupPolicy: params.groupPolicy } : {}),
    ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
  };
  return {
    account: {
      accountId: "default",
      channelAccessToken: "token",
      channelSecret: "secret",
      config: {
        ...lineConfig,
        ...(params.requireMention === undefined
          ? {}
          : { groups: { "*": { requireMention: params.requireMention } } }),
      },
      enabled: true,
      tokenSource: "config",
    },
    cfg: { channels: { line: lineConfig } },
    mediaMaxBytes: 1,
    processMessage: params.processMessage,
    runtime: createRuntime(),
    ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    ...(params.replayCache ? { replayCache: params.replayCache } : {}),
  };
}

function createOpenGroupReplayContext(
  processMessage: LineWebhookContext["processMessage"],
  replayCache: ReturnType<typeof createLineWebhookReplayCache>,
): Parameters<typeof handleLineWebhookEvents>[1] {
  return createLineWebhookTestContext({
    groupPolicy: "open",
    processMessage,
    replayCache,
    requireMention: false,
  });
}

async function expectGroupMessageBlocked(params: {
  processMessage: LineWebhookContext["processMessage"];
  event: MessageEvent;
  context: Parameters<typeof handleLineWebhookEvents>[1];
}) {
  await handleLineWebhookEvents([params.event], params.context);
  expect(params.processMessage).not.toHaveBeenCalled();
  expect(buildLineMessageContextMock).not.toHaveBeenCalled();
}

async function expectRequireMentionGroupMessageProcessed(event: MessageEvent) {
  const processMessage = vi.fn();
  await handleLineWebhookEvents(
    [event],
    createLineWebhookTestContext({
      groupPolicy: "open",
      processMessage,
      requireMention: true,
    }),
  );
  expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
  expect(processMessage).toHaveBeenCalledTimes(1);
}

async function startInflightReplayDuplicate(params: {
  event: MessageEvent;
  processMessage: LineWebhookContext["processMessage"];
}) {
  const context = createOpenGroupReplayContext(
    params.processMessage,
    createLineWebhookReplayCache(),
  );
  const firstRun = handleLineWebhookEvents([params.event], context);
  await Promise.resolve();
  const secondRun = handleLineWebhookEvents([params.event], context);
  return { firstRun, secondRun };
}

describe("handleLineWebhookEvents", () => {
  beforeAll(async () => {
    ({ handleLineWebhookEvents, createLineWebhookReplayCache } = await import("./bot-handlers.js"));
  });

  beforeEach(() => {
    buildLineMessageContextMock.mockReset();
    buildLineMessageContextMock.mockImplementation(async () => ({
      accountId: "default",
      ctxPayload: { From: "line:group:group-1" },
      isGroup: true,
      replyToken: "reply-token",
      route: { agentId: "default" },
    }));
    buildLinePostbackContextMock.mockReset();
    buildLinePostbackContextMock.mockImplementation(async () => null as unknown);
    readAllowFromStoreMock.mockReset();
    readAllowFromStoreMock.mockImplementation(async () => [] as string[]);
    upsertPairingRequestMock.mockReset();
    upsertPairingRequestMock.mockImplementation(async () => ({ code: "CODE", created: true }));
  });
  it("blocks group messages when groupPolicy is disabled", async () => {
    const processMessage = vi.fn();
    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m1", text: "hi", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { groupId: "group-1", type: "group", userId: "user-1" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-1",
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: { groupPolicy: "disabled" },
        enabled: true,
        tokenSource: "config",
      },
      cfg: { channels: { line: { groupPolicy: "disabled" } } },
      mediaMaxBytes: 1,
      processMessage,
      runtime: createRuntime(),
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("blocks group messages when allowlist is empty", async () => {
    const processMessage = vi.fn();
    await expectGroupMessageBlocked({
      context: createLineWebhookTestContext({
        groupPolicy: "allowlist",
        processMessage,
      }),
      event: createTestMessageEvent({
        message: { id: "m2", quoteToken: "quote-token", text: "hi", type: "text" },
        source: { groupId: "group-1", type: "group", userId: "user-2" },
        webhookEventId: "evt-2",
      }),
      processMessage,
    });
  });

  it("allows group messages when sender is in groupAllowFrom", async () => {
    const processMessage = vi.fn();
    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m3", text: "hi", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { groupId: "group-1", type: "group", userId: "user-3" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-3",
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: {
          groupAllowFrom: ["user-3"],
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: false } },
        },
        enabled: true,
        tokenSource: "config",
      },
      cfg: {
        channels: { line: { groupAllowFrom: ["user-3"], groupPolicy: "allowlist" } },
      },
      mediaMaxBytes: 1,
      processMessage,
      runtime: createRuntime(),
    });

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks group sender not in groupAllowFrom even when sender is paired in DM store", async () => {
    readAllowFromStoreMock.mockResolvedValueOnce(["user-store"]);
    const processMessage = vi.fn();
    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m5", text: "hi", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { groupId: "group-1", type: "group", userId: "user-store" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-5",
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: { groupAllowFrom: ["user-group"], groupPolicy: "allowlist" },
        enabled: true,
        tokenSource: "config",
      },
      cfg: {
        channels: { line: { groupAllowFrom: ["user-group"], groupPolicy: "allowlist" } },
      },
      mediaMaxBytes: 1,
      processMessage,
      runtime: createRuntime(),
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("line", undefined, "default");
  });

  it("blocks group messages without sender id when groupPolicy is allowlist", async () => {
    const processMessage = vi.fn();
    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m5a", text: "hi", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { groupId: "group-1", type: "group" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-5a",
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: { groupAllowFrom: ["user-5"], groupPolicy: "allowlist" },
        enabled: true,
        tokenSource: "config",
      },
      cfg: {
        channels: { line: { groupAllowFrom: ["user-5"], groupPolicy: "allowlist" } },
      },
      mediaMaxBytes: 1,
      processMessage,
      runtime: createRuntime(),
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("does not authorize group messages from DM pairing-store entries when group allowlist is empty", async () => {
    readAllowFromStoreMock.mockResolvedValueOnce(["user-5"]);
    const processMessage = vi.fn();
    await expectGroupMessageBlocked({
      context: {
        account: {
          accountId: "default",
          channelAccessToken: "token",
          channelSecret: "secret",
          config: {
            allowFrom: [],
            dmPolicy: "pairing",
            groupAllowFrom: [],
            groupPolicy: "allowlist",
          },
          enabled: true,
          tokenSource: "config",
        },
        cfg: { channels: { line: { groupPolicy: "allowlist" } } },
        mediaMaxBytes: 1,
        processMessage,
        runtime: createRuntime(),
      },
      event: createTestMessageEvent({
        message: { id: "m5b", quoteToken: "quote-token", text: "hi", type: "text" },
        source: { groupId: "group-1", type: "group", userId: "user-5" },
        webhookEventId: "evt-5b",
      }),
      processMessage,
    });
  });

  it("blocks group messages when wildcard group config disables groups", async () => {
    const processMessage = vi.fn();
    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m4", text: "hi", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { groupId: "group-2", type: "group", userId: "user-4" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-4",
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: { groupPolicy: "open", groups: { "*": { enabled: false } } },
        enabled: true,
        tokenSource: "config",
      },
      cfg: { channels: { line: { groupPolicy: "open" } } },
      mediaMaxBytes: 1,
      processMessage,
      runtime: createRuntime(),
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("scopes DM pairing requests to accountId", async () => {
    const processMessage = vi.fn();
    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m5", text: "hi", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { type: "user", userId: "user-5" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-5",
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: { allowFrom: ["user-owner"], dmPolicy: "pairing" },
        enabled: true,
        tokenSource: "config",
      },
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      mediaMaxBytes: 1,
      processMessage,
      runtime: createRuntime(),
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        channel: "line",
        id: "user-5",
      }),
    );
  });

  it("does not authorize DM senders from another account's pairing-store entries", async () => {
    const processMessage = vi.fn();
    readAllowFromStoreMock.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[2] as string | undefined;
      if (accountId === "work") {
        return [];
      }
      return ["cross-account-user"];
    });
    upsertPairingRequestMock.mockResolvedValue({ code: "CODE", created: false });

    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m6", text: "hi", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { type: "user", userId: "cross-account-user" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-6",
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      account: {
        accountId: "work",
        enabled: true,
        channelAccessToken: "token-work", // Pragma: allowlist secret
        channelSecret: "secret-work", // Pragma: allowlist secret
        tokenSource: "config",
        config: { dmPolicy: "pairing" },
      },
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      mediaMaxBytes: 1,
      processMessage,
      runtime: createRuntime(),
    });

    expect(readAllowFromStoreMock).toHaveBeenCalledWith("line", undefined, "work");
    expect(processMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "line",
        id: "cross-account-user",
      }),
    );
  });

  it("deduplicates replayed webhook events by webhookEventId before processing", async () => {
    const processMessage = vi.fn();
    const event = createReplayMessageEvent({
      groupId: "group-replay",
      isRedelivery: true,
      messageId: "m-replay",
      userId: "user-replay",
      webhookEventId: "evt-replay-1",
    });
    const context = createOpenGroupReplayContext(processMessage, createLineWebhookReplayCache());

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("skips concurrent redeliveries while the first event is still processing", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = createReplayMessageEvent({
      groupId: "group-inflight",
      isRedelivery: true,
      messageId: "m-inflight",
      userId: "user-inflight",
      webhookEventId: "evt-inflight-1",
    });
    const { firstRun, secondRun } = await startInflightReplayDuplicate({ event, processMessage });
    resolveFirst?.();
    await Promise.all([firstRun, secondRun]);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("mirrors in-flight replay failures so concurrent duplicates also fail", async () => {
    let rejectFirst: ((err: Error) => void) | undefined;
    const firstDone = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = createReplayMessageEvent({
      groupId: "group-inflight",
      isRedelivery: true,
      messageId: "m-inflight-fail",
      userId: "user-inflight",
      webhookEventId: "evt-inflight-fail-1",
    });
    const { firstRun, secondRun } = await startInflightReplayDuplicate({ event, processMessage });
    const firstFailure = expect(firstRun).rejects.toThrow("transient inflight failure");
    const secondFailure = expect(secondRun).rejects.toThrow("transient inflight failure");
    rejectFirst?.(new Error("transient inflight failure"));

    await Promise.all([firstFailure, secondFailure]);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates redeliveries by LINE message id when webhookEventId changes", async () => {
    const processMessage = vi.fn();
    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "m-dup-1", text: "hello", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { groupId: "group-dup", type: "group", userId: "user-dup" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-dup-1",
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: {
          groupAllowFrom: ["user-dup"],
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: false } },
        },
        enabled: true,
        tokenSource: "config",
      },
      cfg: {
        channels: { line: { groupAllowFrom: ["user-dup"], groupPolicy: "allowlist" } },
      },
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
      runtime: createRuntime(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          deliveryContext: { isRedelivery: true },
          webhookEventId: "evt-dup-redelivery",
        } as MessageEvent,
      ],
      context,
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates postback redeliveries by webhookEventId when replyToken changes", async () => {
    const processMessage = vi.fn();
    buildLinePostbackContextMock.mockResolvedValue({
      accountId: "default",
      ctxPayload: { From: "line:user:user-postback" },
      isGroup: false,
      route: { agentId: "default" },
    });
    const event = {
      deliveryContext: { isRedelivery: false },
      mode: "active",
      postback: { data: "action=confirm" },
      replyToken: "reply-token-1",
      source: { type: "user", userId: "user-postback" },
      timestamp: Date.now(),
      type: "postback",
      webhookEventId: "evt-postback-1",
    } as PostbackEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      account: {
        accountId: "default",
        channelAccessToken: "token",
        channelSecret: "secret",
        config: { dmPolicy: "open" },
        enabled: true,
        tokenSource: "config",
      },
      cfg: { channels: { line: { dmPolicy: "open" } } },
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
      runtime: createRuntime(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          deliveryContext: { isRedelivery: true },
          replyToken: "reply-token-2",
        } as PostbackEvent,
      ],
      context,
    );

    expect(buildLinePostbackContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("skips group messages by default when requireMention is not configured", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-default-skip", quoteToken: "q-default", text: "hi there", type: "text" },
      source: { groupId: "group-default", type: "group", userId: "user-default" },
      webhookEventId: "evt-default-skip",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        groupPolicy: "open",
        processMessage,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("records unmentioned group messages as pending history", async () => {
    const processMessage = vi.fn();
    const groupHistories = new Map<string, HistoryEntry[]>();
    const event = createTestMessageEvent({
      message: { id: "m-hist-1", quoteToken: "q-hist-1", text: "hello history", type: "text" },
      source: { groupId: "group-hist-1", type: "group", userId: "user-hist" },
      timestamp: 1_700_000_000_000,
      webhookEventId: "evt-hist-1",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        groupHistories,
        groupPolicy: "open",
        processMessage,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    const entries = groupHistories.get("group-hist-1");
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({
      body: "hello history",
      sender: "user:user-hist",
      timestamp: 1_700_000_000_000,
    });
  });

  it("skips group messages without mention when requireMention is set", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-mention-1", quoteToken: "q-mention-1", text: "hi there", type: "text" },
      source: { groupId: "group-mention", type: "group", userId: "user-mention" },
      webhookEventId: "evt-mention-1",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        groupPolicy: "open",
        processMessage,
        requireMention: true,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("processes group messages with bot mention when requireMention is set", async () => {
    const processMessage = vi.fn();
    // Simulate a LINE text message with mention.mentionees containing isSelf=true
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-2",
        mention: {
          mentionees: [{ index: 0, isSelf: true, length: 4, type: "user" }],
        },
        text: "@Bot hi there",
        type: "text",
      } as unknown as MessageEvent["message"],
      source: { groupId: "group-mention", type: "group", userId: "user-mention" },
      webhookEventId: "evt-mention-2",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        groupPolicy: "open",
        processMessage,
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("processes group messages with @all mention when requireMention is set", async () => {
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-3",
        mention: {
          mentionees: [{ index: 0, length: 4, type: "all" }],
        },
        text: "@All hi there",
        type: "text",
      } as MessageEvent["message"],
      source: { groupId: "group-mention", type: "group", userId: "user-mention" },
      webhookEventId: "evt-mention-3",
    });

    await expectRequireMentionGroupMessageProcessed(event);
  });

  it("does not apply requireMention gating to DM messages", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-mention-dm", quoteToken: "q-mention-dm", text: "hi", type: "text" },
      source: { type: "user", userId: "user-dm" },
      webhookEventId: "evt-mention-dm",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        dmPolicy: "open",
        processMessage,
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("allows non-text group messages through when requireMention is set (cannot detect mention)", async () => {
    // Image message -- LINE only carries mention metadata on text messages.
    const event = createTestMessageEvent({
      message: {
        contentProvider: { type: "line" },
        id: "m-mention-img",
        quoteToken: "q-mention-img",
        type: "image",
      },
      source: { groupId: "group-1", type: "group", userId: "user-img" },
      webhookEventId: "evt-mention-img",
    });

    await expectRequireMentionGroupMessageProcessed(event);
  });

  it("does not bypass mention gating when non-bot mention is present with control command", async () => {
    const processMessage = vi.fn();
    // Text message mentions another user (not bot) together with a control command.
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-other",
        mention: { mentionees: [{ index: 0, isSelf: false, length: 6, type: "user" }] },
        text: "@other !status",
        type: "text",
      } as unknown as MessageEvent["message"],
      source: { groupId: "group-1", type: "group", userId: "user-other" },
      webhookEventId: "evt-mention-other",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        groupPolicy: "open",
        processMessage,
        requireMention: true,
      }),
    );

    // Should be skipped because there is a non-bot mention and the bot was not mentioned.
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("does not mark replay cache when event processing fails", async () => {
    const processMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);
    const event = createReplayMessageEvent({
      groupId: "group-retry",
      isRedelivery: false,
      messageId: "m-fail-then-retry",
      userId: "user-retry",
      webhookEventId: "evt-fail-then-retry",
    });
    const context = createOpenGroupReplayContext(processMessage, createLineWebhookReplayCache());

    await expect(handleLineWebhookEvents([event], context)).rejects.toThrow("transient failure");
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(2);
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(context.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("line: event handler failed: Error: transient failure"),
    );
  });
});
