import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const {
  createChannelPairingControllerMock,
  dispatchInboundReplyWithBaseMock,
  readStoreAllowFromForDmPolicyMock,
  resolveDmGroupAccessWithCommandGateMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => ({
    createChannelPairingControllerMock: vi.fn(),
    dispatchInboundReplyWithBaseMock: vi.fn(),
    readStoreAllowFromForDmPolicyMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    resolveDmGroupAccessWithCommandGateMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  }));

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkRoomKindMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    dispatchInboundReplyWithBase: dispatchInboundReplyWithBaseMock,
    readStoreAllowFromForDmPolicy: readStoreAllowFromForDmPolicyMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    resolveDmGroupAccessWithCommandGate: resolveDmGroupAccessWithCommandGateMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
}));

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: resolveNextcloudTalkRoomKindMock,
  };
});

function installRuntime(params?: {
  buildMentionRegexes?: () => RegExp[];
  matchesMentionPatterns?: (body: string, regexes: RegExp[]) => boolean;
}) {
  setNextcloudTalkRuntime({
    channel: {
      commands: {
        shouldHandleTextCommands: vi.fn(() => false),
      },
      mentions: {
        buildMentionRegexes: params?.buildMentionRegexes ?? vi.fn(() => []),
        matchesMentionPatterns: params?.matchesMentionPatterns ?? vi.fn(() => false),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
      },
    },
  } as unknown as PluginRuntime);
}

function createRuntimeEnv() {
  return {
    error: vi.fn(),
    log: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(
  overrides?: Partial<ResolvedNextcloudTalkAccount>,
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    baseUrl: "https://cloud.example.com",
    config: {
      allowFrom: [],
      dmPolicy: "pairing",
      groupAllowFrom: [],
      groupPolicy: "allowlist",
    },
    enabled: true,
    secret: "secret",
    secretSource: "config",
    ...overrides,
  };
}

function createMessage(
  overrides?: Partial<NextcloudTalkInboundMessage>,
): NextcloudTalkInboundMessage {
  return {
    isGroupChat: false,
    mediaType: "text/plain",
    messageId: "msg-1",
    roomName: "Room 1",
    roomToken: "room-1",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("nextcloud-talk inbound behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("direct");
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
    readStoreAllowFromForDmPolicyMock.mockResolvedValue([]);
  });

  // The DM pairing assertion currently depends on a mocked runtime barrel that Vitest
  // Does not bind reliably for this extension package.
  it.skip("issues a DM pairing challenge and sends the challenge text", async () => {
    createChannelPairingControllerMock.mockReturnValue({
      issueChallenge: vi.fn(),
      readStoreForDmPolicy: vi.fn(),
    });
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      commandAuthorized: false,
      decision: "pairing",
      effectiveGroupAllowFrom: [],
      reason: "pairing_required",
    });
    sendMessageNextcloudTalkMock.mockResolvedValue(undefined);

    const statusSink = vi.fn();
    await handleNextcloudTalkInbound({
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      message: createMessage(),
      runtime: createRuntimeEnv(),
      statusSink,
    });
  });

  it("drops unmentioned group traffic before dispatch", async () => {
    installRuntime({
      buildMentionRegexes: vi.fn(() => [/@openclaw/i]),
      matchesMentionPatterns: vi.fn(() => false),
    });
    createChannelPairingControllerMock.mockReturnValue({
      issueChallenge: vi.fn(),
      readStoreForDmPolicy: vi.fn(),
    });
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      commandAuthorized: false,
      decision: "allow",
      effectiveGroupAllowFrom: ["user-1"],
      reason: "allow",
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      account: createAccount({
        config: {
          allowFrom: [],
          dmPolicy: "pairing",
          groupAllowFrom: ["user-1"],
          groupPolicy: "allowlist",
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      message: createMessage({
        isGroupChat: true,
        roomName: "Ops",
        roomToken: "room-group",
      }),
      runtime,
    });

    expect(dispatchInboundReplyWithBaseMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("nextcloud-talk: drop room room-group (no mention)");
  });
});
