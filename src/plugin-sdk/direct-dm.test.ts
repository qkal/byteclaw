import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createDirectDmPreCryptoGuardPolicy,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "./direct-dm.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

function createDirectDmRuntime() {
  const recordInboundSession = vi.fn(async () => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "reply text" });
  });
  return {
    dispatchReplyWithBufferedBlockDispatcher,
    recordInboundSession,
    runtime: {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher,
          finalizeInboundContext: vi.fn((ctx) => ctx),
          formatAgentEnvelope: vi.fn(({ body }) => `env:${body}`),
          resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
        },
        routing: {
          resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
            agentId: "agent-main",
            accountId,
            sessionKey: `dm:${peer.id}`,
          })),
        },
        session: {
          readSessionUpdatedAt: vi.fn(() => 1234),
          recordInboundSession,
          resolveStorePath: vi.fn(() => "/tmp/direct-dm-session-store"),
        },
      },
    } as never,
  };
}

describe("plugin-sdk/direct-dm", () => {
  it("resolves inbound DM access and command auth through one helper", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      accountId: "default",
      allowFrom: [],
      cfg: baseCfg,
      channel: "nostr",
      dmPolicy: "pairing",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      modeWhenAccessGroupsOff: "configured",
      rawBody: "/status",
      readStoreAllowFrom: async () => ["paired-user"],
      runtime: {
        resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
          authorizers.some((entry) => entry.configured && entry.allowed),
        shouldComputeCommandAuthorized: () => true,
      },
      senderId: "paired-user",
    });

    expect(result.access.decision).toBe("allow");
    expect(result.access.effectiveAllowFrom).toEqual(["paired-user"]);
    expect(result.senderAllowedForCommands).toBe(true);
    expect(result.commandAuthorized).toBe(true);
  });

  it("creates a pre-crypto authorizer that issues pairing and blocks unknown senders", async () => {
    const issuePairingChallenge = vi.fn(async () => {});
    const onBlocked = vi.fn();
    const authorizer = createPreCryptoDirectDmAuthorizer({
      issuePairingChallenge,
      onBlocked,
      resolveAccess: async (senderId) => ({
        access:
          senderId === "pair-me"
            ? {
                decision: "pairing" as const,
                effectiveAllowFrom: [],
                reason: "dmPolicy=pairing (not allowlisted)",
                reasonCode: "dm_policy_pairing_required",
              }
            : {
                decision: "block" as const,
                effectiveAllowFrom: [],
                reason: "dmPolicy=disabled",
                reasonCode: "dm_policy_disabled",
              },
      }),
    });

    await expect(
      Promise.all([
        authorizer({
          reply: async () => {},
          senderId: "pair-me",
        }),
        authorizer({
          reply: async () => {},
          senderId: "blocked",
        }),
      ]),
    ).resolves.toEqual(["pairing", "block"]);

    expect(issuePairingChallenge).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith({
      reason: "dmPolicy=disabled",
      reasonCode: "dm_policy_disabled",
      senderId: "blocked",
    });
  });

  it("builds a shared pre-crypto guard policy with partial overrides", () => {
    const policy = createDirectDmPreCryptoGuardPolicy({
      maxFutureSkewSec: 30,
      rateLimit: {
        maxPerSenderPerWindow: 5,
      },
    });

    expect(policy.allowedKinds).toEqual([4]);
    expect(policy.maxFutureSkewSec).toBe(30);
    expect(policy.maxCiphertextBytes).toBe(16 * 1024);
    expect(policy.rateLimit.maxPerSenderPerWindow).toBe(5);
    expect(policy.rateLimit.maxGlobalPerWindow).toBe(200);
  });

  it("dispatches direct DMs through the standard route/session/reply pipeline", async () => {
    const { recordInboundSession, dispatchReplyWithBufferedBlockDispatcher, runtime } =
      createDirectDmRuntime();
    const deliver = vi.fn(async () => {});

    const result = await dispatchInboundDirectDmWithRuntime({
      accountId: "default",
      cfg: {
        session: { store: { type: "jsonl" } },
      } as never,
      channel: "nostr",
      channelLabel: "Nostr",
      commandAuthorized: true,
      conversationLabel: "sender-1",
      deliver,
      messageId: "event-123",
      onDispatchError: () => {},
      onRecordError: () => {},
      peer: { id: "sender-1", kind: "direct" },
      rawBody: "hello world",
      recipientAddress: "nostr:bot-1",
      runtime,
      senderAddress: "nostr:sender-1",
      senderId: "sender-1",
      timestamp: 1_710_000_000_000,
    });

    expect(result.route).toMatchObject({
      accountId: "default",
      agentId: "agent-main",
      sessionKey: "dm:sender-1",
    });
    expect(result.storePath).toBe("/tmp/direct-dm-session-store");
    expect(result.ctxPayload).toMatchObject({
      Body: "env:hello world",
      BodyForAgent: "hello world",
      CommandAuthorized: true,
      From: "nostr:sender-1",
      MessageSid: "event-123",
      SenderId: "sender-1",
      To: "nostr:bot-1",
    });
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "reply text" });
  });
});
