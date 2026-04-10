import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  type DmGroupAccessReasonCode,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "../security/dm-policy-shared.js";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope.js";
import { recordInboundSessionAndDispatchReply } from "./inbound-reply-dispatch.js";
import type { OutboundReplyPayload } from "./reply-payload.js";

export interface DirectDmCommandAuthorizationRuntime {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: { configured: boolean; allowed: boolean }[];
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  }) => boolean;
}

export interface ResolvedInboundDirectDmAccess {
  access: {
    decision: "allow" | "block" | "pairing";
    reasonCode: DmGroupAccessReasonCode;
    reason: string;
    effectiveAllowFrom: string[];
  };
  shouldComputeAuth: boolean;
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
}

/** Resolve direct-DM policy, effective allowlists, and optional command auth in one place. */
export async function resolveInboundDirectDmAccessWithRuntime(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  allowFrom?: (string | number)[] | null;
  senderId: string;
  rawBody: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  runtime: DirectDmCommandAuthorizationRuntime;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  readStoreAllowFrom?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<ResolvedInboundDirectDmAccess> {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const storeAllowFrom =
    dmPolicy === "pairing"
      ? await readStoreAllowFromForDmPolicy({
          accountId: params.accountId,
          dmPolicy,
          provider: params.channel,
          readStore: params.readStoreAllowFrom,
        })
      : [];

  const access = resolveDmGroupAccessWithLists({
    allowFrom: params.allowFrom,
    dmPolicy,
    groupAllowFromFallbackToAllowFrom: false,
    isGroup: false,
    isSenderAllowed: (allowEntries) => params.isSenderAllowed(params.senderId, allowEntries),
    storeAllowFrom,
  });

  const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    access.effectiveAllowFrom,
  );
  const commandAuthorized = shouldComputeAuth
    ? dmPolicy === "open"
      ? true
      : params.runtime.resolveCommandAuthorizedFromAuthorizers({
          authorizers: [
            {
              configured: access.effectiveAllowFrom.length > 0,
              allowed: senderAllowedForCommands,
            },
          ],
          modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
          useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
        })
    : undefined;

  return {
    access: {
      decision: access.decision,
      effectiveAllowFrom: access.effectiveAllowFrom,
      reason: access.reason,
      reasonCode: access.reasonCode,
    },
    commandAuthorized,
    senderAllowedForCommands,
    shouldComputeAuth,
  };
}

/** Convert resolved DM policy into a pre-crypto allow/block/pairing callback. */
export function createPreCryptoDirectDmAuthorizer(params: {
  resolveAccess: (
    senderId: string,
  ) => Promise<Pick<ResolvedInboundDirectDmAccess, "access"> | ResolvedInboundDirectDmAccess>;
  issuePairingChallenge?: (params: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<void>;
  onBlocked?: (params: {
    senderId: string;
    reason: string;
    reasonCode: DmGroupAccessReasonCode;
  }) => void;
}) {
  return async (input: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }): Promise<"allow" | "block" | "pairing"> => {
    const resolved = await params.resolveAccess(input.senderId);
    const access = "access" in resolved ? resolved.access : resolved;
    if (access.decision === "allow") {
      return "allow";
    }
    if (access.decision === "pairing") {
      if (params.issuePairingChallenge) {
        await params.issuePairingChallenge({
          reply: input.reply,
          senderId: input.senderId,
        });
      }
      return "pairing";
    }
    params.onBlocked?.({
      reason: access.reason,
      reasonCode: access.reasonCode,
      senderId: input.senderId,
    });
    return "block";
  };
}

export interface DirectDmPreCryptoGuardPolicy {
  allowedKinds: readonly number[];
  maxFutureSkewSec: number;
  maxCiphertextBytes: number;
  maxPlaintextBytes: number;
  rateLimit: {
    windowMs: number;
    maxPerSenderPerWindow: number;
    maxGlobalPerWindow: number;
    maxTrackedSenderKeys: number;
  };
}

export type DirectDmPreCryptoGuardPolicyOverrides = Partial<
  Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">
> & {
  rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};

/** Shared policy object for DM-style pre-crypto guardrails. */
export function createDirectDmPreCryptoGuardPolicy(
  overrides: DirectDmPreCryptoGuardPolicyOverrides = {},
): DirectDmPreCryptoGuardPolicy {
  return {
    allowedKinds: overrides.allowedKinds ?? [4],
    maxCiphertextBytes: overrides.maxCiphertextBytes ?? 16 * 1024,
    maxFutureSkewSec: overrides.maxFutureSkewSec ?? 120,
    maxPlaintextBytes: overrides.maxPlaintextBytes ?? 8 * 1024,
    rateLimit: {
      maxGlobalPerWindow: overrides.rateLimit?.maxGlobalPerWindow ?? 200,
      maxPerSenderPerWindow: overrides.rateLimit?.maxPerSenderPerWindow ?? 20,
      maxTrackedSenderKeys: overrides.rateLimit?.maxTrackedSenderKeys ?? 4096,
      windowMs: overrides.rateLimit?.windowMs ?? 60_000,
    },
  };
}

interface DirectDmRoutePeer {
  kind: "direct";
  id: string;
}

interface DirectDmRoute {
  agentId: string;
  sessionKey: string;
  accountId?: string;
}

interface DirectDmRuntime {
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
        peer: DirectDmRoutePeer;
      }) => DirectDmRoute;
    };
    session: {
      resolveStorePath: typeof import("../config/sessions.js").resolveStorePath;
      readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: typeof import("../channels/session.js").recordInboundSession;
    };
    reply: {
      resolveEnvelopeFormatOptions: (
        cfg: OpenClawConfig,
      ) => ReturnType<typeof import("../auto-reply/envelope.js").resolveEnvelopeFormatOptions>;
      formatAgentEnvelope: typeof import("../auto-reply/envelope.js").formatAgentEnvelope;
      finalizeInboundContext: typeof import("../auto-reply/reply/inbound-context.js").finalizeInboundContext;
      dispatchReplyWithBufferedBlockDispatcher: typeof import("../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
    };
  };
}

/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
export async function dispatchInboundDirectDmWithRuntime(params: {
  cfg: OpenClawConfig;
  runtime: DirectDmRuntime;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
}): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: params.channel,
    peer: params.peer,
    runtime: params.runtime.channel,
    sessionStore: params.cfg.session?.store,
  });

  const { storePath, body } = buildEnvelope({
    body: params.rawBody,
    channel: params.channelLabel,
    from: params.conversationLabel,
    timestamp: params.timestamp,
  });

  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    AccountId: route.accountId ?? params.accountId,
    Body: body,
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    ChatType: "direct",
    CommandAuthorized: params.commandAuthorized,
    CommandBody: params.commandBody ?? params.rawBody,
    ConversationLabel: params.conversationLabel,
    From: params.senderAddress,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    OriginatingChannel: params.originatingChannel ?? params.channel,
    OriginatingTo: params.originatingTo ?? params.recipientAddress,
    Provider: params.provider ?? params.channel,
    RawBody: params.rawBody,
    SenderId: params.senderId,
    SessionKey: route.sessionKey,
    Surface: params.surface ?? params.channel,
    Timestamp: params.timestamp,
    To: params.recipientAddress,
    ...params.extraContext,
  });

  await recordInboundSessionAndDispatchReply({
    accountId: route.accountId ?? params.accountId,
    agentId: route.agentId,
    cfg: params.cfg,
    channel: params.channel,
    ctxPayload,
    deliver: params.deliver,
    dispatchReplyWithBufferedBlockDispatcher:
      params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    onDispatchError: params.onDispatchError,
    onRecordError: params.onRecordError,
    recordInboundSession: params.runtime.channel.session.recordInboundSession,
    routeSessionKey: route.sessionKey,
    storePath,
  });

  return {
    ctxPayload,
    route,
    storePath,
  };
}
