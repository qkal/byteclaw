import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type ChannelOutboundAdapter,
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "./channel-api.js";
import type { MetricEvent, MetricsSnapshot } from "./metrics.js";
import { type NostrBusHandle, normalizePubkey, startNostrBus } from "./nostr-bus.js";
import { getNostrRuntime } from "./runtime.js";
import { type ResolvedNostrAccount, resolveDefaultNostrAccountId } from "./types.js";

type NostrGatewayStart = NonNullable<
  NonNullable<ChannelPlugin<ResolvedNostrAccount>["gateway"]>["startAccount"]
>;
type NostrOutboundAdapter = Pick<
  ChannelOutboundAdapter,
  "deliveryMode" | "textChunkLimit" | "sendText"
> & {
  sendText: NonNullable<ChannelOutboundAdapter["sendText"]>;
};

const activeBuses = new Map<string, NostrBusHandle>();
const metricsSnapshots = new Map<string, MetricsSnapshot>();

function normalizeNostrAllowEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  try {
    return normalizePubkey(trimmed.replace(/^nostr:/i, ""));
  } catch {
    return null;
  }
}

function isNostrSenderAllowed(senderPubkey: string, allowFrom: string[]): boolean {
  const normalizedSender = normalizePubkey(senderPubkey);
  for (const entry of allowFrom) {
    const normalized = normalizeNostrAllowEntry(entry);
    if (normalized === "*" || normalized === normalizedSender) {
      return true;
    }
  }
  return false;
}

async function resolveNostrDirectAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: (string | number)[] | undefined;
  senderPubkey: string;
  rawBody: string;
  runtime: Parameters<typeof resolveInboundDirectDmAccessWithRuntime>[0]["runtime"];
}) {
  return resolveInboundDirectDmAccessWithRuntime({
    accountId: params.accountId,
    allowFrom: params.allowFrom,
    cfg: params.cfg,
    channel: "nostr",
    dmPolicy: params.dmPolicy,
    isSenderAllowed: isNostrSenderAllowed,
    modeWhenAccessGroupsOff: "configured",
    rawBody: params.rawBody,
    runtime: params.runtime,
    senderId: params.senderPubkey,
  });
}

export const startNostrGatewayAccount: NostrGatewayStart = async (ctx) => {
  const {account} = ctx;
  ctx.setStatus({
    accountId: account.accountId,
    publicKey: account.publicKey,
  });
  ctx.log?.info?.(`[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`);

  if (!account.configured) {
    throw new Error("Nostr private key not configured");
  }

  const runtime = getNostrRuntime();
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: "nostr",
    core: runtime,
  });
  const resolveInboundAccess = async (senderPubkey: string, rawBody: string) =>
    await resolveNostrDirectAccess({
      accountId: account.accountId,
      allowFrom: account.config.allowFrom,
      cfg: ctx.cfg,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      rawBody,
      runtime: {
        resolveCommandAuthorizedFromAuthorizers:
          runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
        shouldComputeCommandAuthorized: runtime.channel.commands.shouldComputeCommandAuthorized,
      },
      senderPubkey,
    });

  let busHandle: NostrBusHandle | null = null;

  const authorizeSender = createPreCryptoDirectDmAuthorizer({
    issuePairingChallenge: async ({ senderId, reply }) => {
      await pairing.issueChallenge({
        onCreated: () => {
          ctx.log?.debug?.(`[${account.accountId}] nostr pairing request sender=${senderId}`);
        },
        onReplyError: (err) => {
          ctx.log?.warn?.(
            `[${account.accountId}] nostr pairing reply failed for ${senderId}: ${String(err)}`,
          );
        },
        sendPairingReply: reply,
        senderId,
        senderIdLine: `Your Nostr pubkey: ${senderId}`,
      });
    },
    onBlocked: ({ senderId, reason }) => {
      ctx.log?.debug?.(`[${account.accountId}] blocked Nostr sender ${senderId} (${reason})`);
    },
    resolveAccess: async (senderPubkey) => await resolveInboundAccess(senderPubkey, ""),
  });

  const bus = await startNostrBus({
    accountId: account.accountId,
    authorizeSender: async ({ senderPubkey, reply }) =>
      await authorizeSender({ reply, senderId: senderPubkey }),
    onConnect: (relay) => {
      ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
    },
    onDisconnect: (relay) => {
      ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
    },
    onEose: (relays) => {
      ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`);
    },
    onError: (error, context) => {
      ctx.log?.error?.(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
    },
    onMessage: async (senderPubkey, text, reply, meta) => {
      const resolvedAccess = await resolveInboundAccess(senderPubkey, text);
      if (resolvedAccess.access.decision !== "allow") {
        ctx.log?.warn?.(
          `[${account.accountId}] dropping Nostr DM after preflight drift (${senderPubkey}, ${resolvedAccess.access.reason})`,
        );
        return;
      }

      await dispatchInboundDirectDmWithRuntime({
        accountId: account.accountId,
        cfg: ctx.cfg,
        channel: "nostr",
        channelLabel: "Nostr",
        commandAuthorized: resolvedAccess.commandAuthorized,
        conversationLabel: senderPubkey,
        deliver: async (payload) => {
          const outboundText =
            payload && typeof payload === "object" && "text" in payload
              ? String((payload as { text?: string }).text ?? "")
              : "";
          if (!outboundText.trim()) {
            return;
          }
          const tableMode = runtime.channel.text.resolveMarkdownTableMode({
            cfg: ctx.cfg,
            channel: "nostr",
            accountId: account.accountId,
          });
          await reply(runtime.channel.text.convertMarkdownTables(outboundText, tableMode));
        },
        messageId: meta.eventId,
        onDispatchError: (err, info) => {
          ctx.log?.error?.(
            `[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`,
          );
        },
        onRecordError: (err) => {
          ctx.log?.error?.(
            `[${account.accountId}] failed recording Nostr inbound session: ${String(err)}`,
          );
        },
        peer: {
          id: senderPubkey,
          kind: "direct",
        },
        rawBody: text,
        recipientAddress: `nostr:${account.publicKey}`,
        runtime,
        senderAddress: `nostr:${senderPubkey}`,
        senderId: senderPubkey,
        timestamp: meta.createdAt * 1000,
      });
    },
    onMetric: (event: MetricEvent) => {
      if (event.name.startsWith("event.rejected.")) {
        ctx.log?.debug?.(
          `[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`,
        );
      } else if (event.name === "relay.circuit_breaker.open") {
        ctx.log?.warn?.(
          `[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`,
        );
      } else if (event.name === "relay.circuit_breaker.close") {
        ctx.log?.info?.(
          `[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`,
        );
      } else if (event.name === "relay.error") {
        ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
      }
      if (busHandle) {
        metricsSnapshots.set(account.accountId, busHandle.getMetrics());
      }
    },
    privateKey: account.privateKey,
    relays: account.relays,
  });

  busHandle = bus;
  activeBuses.set(account.accountId, bus);

  ctx.log?.info?.(
    `[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`,
  );

  return {
    stop: () => {
      bus.close();
      activeBuses.delete(account.accountId);
      metricsSnapshots.delete(account.accountId);
      ctx.log?.info?.(`[${account.accountId}] Nostr provider stopped`);
    },
  };
};

export const nostrPairingTextAdapter = {
  idLabel: "nostrPubkey",
  message: "Your pairing request has been approved!",
  normalizeAllowEntry: (entry: string) => {
    try {
      return normalizePubkey(entry.trim().replace(/^nostr:/i, ""));
    } catch {
      return entry.trim();
    }
  },
  notify: async ({
    cfg,
    id,
    message,
    accountId,
  }: {
    cfg: OpenClawConfig;
    id: string;
    message: string;
    accountId?: string;
  }) => {
    const bus = activeBuses.get(accountId ?? resolveDefaultNostrAccountId(cfg));
    if (bus) {
      await bus.sendDm(id, message);
    }
  },
};

export const nostrOutboundAdapter: NostrOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId }) => {
    const core = getNostrRuntime();
    const aid = accountId ?? resolveDefaultNostrAccountId(cfg);
    const bus = activeBuses.get(aid);
    if (!bus) {
      throw new Error(`Nostr bus not running for account ${aid}`);
    }
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      accountId: aid,
      cfg,
      channel: "nostr",
    });
    const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
    const normalizedTo = normalizePubkey(to);
    await bus.sendDm(normalizedTo, message);
    return attachChannelToResult("nostr", {
      messageId: `nostr-${Date.now()}`,
      to: normalizedTo,
    });
  },
  textChunkLimit: 4000,
};

export function getNostrMetrics(
  accountId: string = DEFAULT_ACCOUNT_ID,
): MetricsSnapshot | undefined {
  const bus = activeBuses.get(accountId);
  if (bus) {
    return bus.getMetrics();
  }
  return metricsSnapshots.get(accountId);
}

export function getActiveNostrBuses(): Map<string, NostrBusHandle> {
  return new Map(activeBuses);
}
