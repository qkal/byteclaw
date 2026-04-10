import { beforeAll, describe, expect, it, vi } from "vitest";

const createChannelPairingController = vi.hoisted(() => vi.fn());
const evaluateGroupRouteAccessForPolicy = vi.hoisted(() => vi.fn());
const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveAllowlistProviderRuntimeGroupPolicy = vi.hoisted(() => vi.fn());
const resolveDefaultGroupPolicy = vi.hoisted(() => vi.fn());
const resolveDmGroupAccessWithLists = vi.hoisted(() => vi.fn());
const resolveInboundMentionDecision = vi.hoisted(() => vi.fn());
const resolveSenderScopedGroupPolicy = vi.hoisted(() => vi.fn());
const warnMissingProviderGroupPolicyFallbackOnce = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  resolveInboundMentionDecision,
}));

vi.mock("../runtime-api.js", () => ({
  GROUP_POLICY_BLOCKED_LABEL: { space: "space" },
  createChannelPairingController,
  evaluateGroupRouteAccessForPolicy,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  resolveSenderScopedGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

function createCore() {
  return {
    channel: {
      commands: {
        isControlCommandMessage: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        shouldComputeCommandAuthorized: vi.fn(() => false),
        shouldHandleTextCommands: vi.fn(() => false),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
      },
    },
  };
}

function primeCommonDefaults() {
  isDangerousNameMatchingEnabled.mockReturnValue(false);
  resolveDefaultGroupPolicy.mockReturnValue("allowlist");
  resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied: false,
  });
  resolveSenderScopedGroupPolicy.mockImplementation(({ groupPolicy }) => groupPolicy);
  evaluateGroupRouteAccessForPolicy.mockReturnValue({
    allowed: true,
  });
  warnMissingProviderGroupPolicyFallbackOnce.mockReturnValue(undefined);
}

const baseAccessConfig = {
  channels: { googlechat: {} },
  commands: { useAccessGroups: true },
} as const;

const defaultSender = {
  senderEmail: "alice@example.com",
  senderId: "users/alice",
  senderName: "Alice",
} as const;

let applyGoogleChatInboundAccessPolicy: typeof import("./monitor-access.js").applyGoogleChatInboundAccessPolicy;

function allowInboundGroupTraffic(options?: {
  effectiveGroupAllowFrom?: string[];
  effectiveWasMentioned?: boolean;
}) {
  createChannelPairingController.mockReturnValue({
    issueChallenge: vi.fn(),
    readAllowFromStore: vi.fn(async () => []),
  });
  resolveDmGroupAccessWithLists.mockReturnValue({
    decision: "allow",
    effectiveAllowFrom: [],
    effectiveGroupAllowFrom: options?.effectiveGroupAllowFrom ?? ["users/alice"],
  });
  resolveInboundMentionDecision.mockReturnValue({
    effectiveWasMentioned: options?.effectiveWasMentioned ?? true,
    shouldSkip: false,
  });
}

async function applyInboundAccessPolicy(
  overrides: Partial<Parameters<typeof applyGoogleChatInboundAccessPolicy>[0]>,
) {
  return applyGoogleChatInboundAccessPolicy({
    account: {
      accountId: "default",
      config: {},
    } as never,
    config: baseAccessConfig as never,
    core: createCore() as never,
    isGroup: true,
    logVerbose: vi.fn(),
    message: { annotations: [] } as never,
    rawBody: "hello team",
    space: { displayName: "Team Room", name: "spaces/AAA" } as never,
    ...defaultSender,
    ...overrides,
  } as never);
}

describe("googlechat inbound access policy", () => {
  beforeAll(async () => {
    ({ applyGoogleChatInboundAccessPolicy } = await import("./monitor-access.js"));
  });

  it("issues a pairing challenge for unauthorized DMs in pairing mode", async () => {
    primeCommonDefaults();
    const issueChallenge = vi.fn(async ({ onCreated, sendPairingReply }) => {
      onCreated?.();
      await sendPairingReply("pairing text");
    });
    createChannelPairingController.mockReturnValue({
      issueChallenge,
      readAllowFromStore: vi.fn(async () => []),
    });
    resolveDmGroupAccessWithLists.mockReturnValue({
      decision: "pairing",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
      reason: "pairing_required",
    });
    sendGoogleChatMessage.mockResolvedValue({ ok: true });

    const statusSink = vi.fn();
    const logVerbose = vi.fn();

    await expect(
      applyGoogleChatInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            dm: { policy: "pairing" },
          },
        } as never,
        config: {
          channels: { googlechat: {} },
        } as never,
        core: createCore() as never,
        isGroup: false,
        logVerbose,
        message: { annotations: [] } as never,
        rawBody: "hello",
        senderEmail: "alice@example.com",
        senderId: "users/abc",
        senderName: "Alice",
        space: { displayName: "DM", name: "spaces/AAA" } as never,
        statusSink,
      }),
    ).resolves.toEqual({ ok: false });

    expect(issueChallenge).toHaveBeenCalledTimes(1);
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account: expect.anything(),
      space: "spaces/AAA",
      text: "pairing text",
    });
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        lastOutboundAt: expect.any(Number),
      }),
    );
  });

  it("allows group traffic when sender and mention gates pass", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic();
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.resolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            botUser: "users/app-bot",
            groups: {
              "spaces/AAA": {
                requireMention: true,
                systemPrompt: " group prompt ",
                users: ["users/alice"],
              },
            },
          },
        } as never,
        core: core as never,
        message: {
          annotations: [
            {
              type: "USER_MENTION",
              userMention: { user: { name: "users/app-bot" } },
            },
          ],
        } as never,
      }),
    ).resolves.toEqual({
      commandAuthorized: true,
      effectiveWasMentioned: true,
      groupSystemPrompt: "group prompt",
      ok: true,
    });
  });

  it("preserves allowlist group policy when a routed space has no sender allowlist", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic({
      effectiveGroupAllowFrom: [],
      effectiveWasMentioned: false,
    });
    resolveSenderScopedGroupPolicy.mockReturnValue("open");
    resolveSenderScopedGroupPolicy.mockClear();
    resolveDmGroupAccessWithLists.mockClear();

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groups: {
              "spaces/AAA": {
                enabled: true,
              },
            },
          },
        } as never,
      }),
    ).resolves.toEqual({
      commandAuthorized: undefined,
      effectiveWasMentioned: false,
      groupSystemPrompt: undefined,
      ok: true,
    });

    expect(resolveSenderScopedGroupPolicy).not.toHaveBeenCalled();
    expect(resolveDmGroupAccessWithLists).toHaveBeenCalledWith(
      expect.objectContaining({
        groupAllowFrom: [],
        groupPolicy: "allowlist",
      }),
    );
  });

  it("drops unauthorized group control commands", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic({
      effectiveGroupAllowFrom: [],
      effectiveWasMentioned: false,
    });
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.resolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);
    core.channel.commands.isControlCommandMessage.mockReturnValue(true);
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        core: core as never,
        logVerbose,
        rawBody: "/admin",
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith("googlechat: drop control command from users/alice");
  });

  it("does not match group policy by mutable space displayName when the stable id differs", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groups: {
              "Finance Ops": {
                requireMention: true,
                systemPrompt: "finance-only prompt",
                users: ["users/alice"],
              },
            },
          },
        } as never,
        core: createCore() as never,
        logVerbose,
        message: {
          annotations: [
            {
              type: "USER_MENTION",
              userMention: { user: { name: "users/app" } },
            },
          ],
        } as never,
        rawBody: "show quarter close status",
        space: { displayName: "Finance Ops", name: "spaces/BBB" } as never,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "Deprecated Google Chat group key detected: group routing now requires stable space ids (spaces/<spaceId>). Update channels.googlechat.groups keys: Finance Ops",
    );
    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });

  it("fails closed instead of falling back to wildcard when a deprecated room key matches", async () => {
    primeCommonDefaults();
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groupPolicy: "open",
            groups: {
              "*": {
                users: ["users/alice"],
              },
              "Finance Ops": {
                enabled: false,
                users: ["users/bob"],
              },
            },
          },
        } as never,
        core: createCore() as never,
        logVerbose,
        rawBody: "show quarter close status",
        space: { displayName: "Finance Ops", name: "spaces/BBB" } as never,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });
});
