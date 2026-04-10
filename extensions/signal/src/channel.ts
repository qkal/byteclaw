import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { type ChannelPlugin, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  attachChannelToResult,
  attachChannelToResults,
} from "openclaw/plugin-sdk/channel-send-result";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import { chunkText, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { type RoutePeer, buildOutboundBaseSessionKey } from "openclaw/plugin-sdk/routing";
import {
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { type ResolvedSignalAccount, resolveSignalAccount } from "./accounts.js";
import { signalApprovalAuth } from "./approval-auth.js";
import { markdownToSignalTextChunks } from "./format.js";
import { signalMessageActions } from "./message-actions.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";
import { resolveSignalOutboundTarget } from "./outbound-session.js";
import { resolveSignalReactionLevel } from "./reaction-level.js";
import { signalSetupAdapter } from "./setup-core.js";
import {
  createSignalPluginBase,
  signalConfigAdapter,
  signalSecurityAdapter,
  signalSetupWizard,
} from "./shared.js";
type SignalSendFn = typeof import("./send.runtime.js").sendMessageSignal;
type SignalProbe = import("./probe.js").SignalProbe;

let signalMonitorModulePromise: Promise<typeof import("./monitor.js")> | null = null;
let signalProbeModulePromise: Promise<typeof import("./probe.js")> | null = null;
let signalSendRuntimePromise: Promise<typeof import("./send.runtime.js")> | null = null;

async function loadSignalMonitorModule() {
  signalMonitorModulePromise ??= import("./monitor.js");
  return await signalMonitorModulePromise;
}

async function loadSignalProbeModule() {
  signalProbeModulePromise ??= import("./probe.js");
  return await signalProbeModulePromise;
}

async function loadSignalSendRuntime() {
  signalSendRuntimePromise ??= import("./send.runtime.js");
  return await signalSendRuntimePromise;
}

async function resolveSignalSendContext(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  deps?: Record<string, unknown>;
}) {
  const send =
    resolveOutboundSendDep<SignalSendFn>(params.deps, "signal") ??
    (await loadSignalSendRuntime()).sendMessageSignal;
  const maxBytes = resolveChannelMediaMaxBytes({
    accountId: params.accountId,
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
  });
  return { maxBytes, send };
}

async function sendSignalOutbound(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  deps?: Record<string, unknown>;
}) {
  const { send, maxBytes } = await resolveSignalSendContext(params);
  return await send(params.to, params.text, {
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
  });
}

function inferSignalTargetChatType(rawTo: string) {
  let to = rawTo.trim();
  if (!to) {
    return undefined;
  }
  if (/^signal:/i.test(to)) {
    to = to.replace(/^signal:/i, "").trim();
  }
  if (!to) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(to);
  if (lower.startsWith("group:")) {
    return "group" as const;
  }
  if (lower.startsWith("username:") || lower.startsWith("u:")) {
    return "direct" as const;
  }
  return "direct" as const;
}

function parseSignalExplicitTarget(raw: string) {
  const normalized = normalizeSignalMessagingTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    chatType: inferSignalTargetChatType(normalized),
    to: normalized,
  };
}

function buildSignalBaseSessionKey(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "signal" });
}

function resolveSignalOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const resolved = resolveSignalOutboundTarget(params.target);
  if (!resolved) {
    return null;
  }
  const baseSessionKey = buildSignalBaseSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    peer: resolved.peer,
  });
  return {
    baseSessionKey,
    sessionKey: baseSessionKey,
    ...resolved,
  };
}

async function sendFormattedSignalText(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string | null;
  deps?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}) {
  const { send, maxBytes } = await resolveSignalSendContext({
    accountId: ctx.accountId ?? undefined,
    cfg: ctx.cfg,
    deps: ctx.deps,
  });
  const limit = resolveTextChunkLimit(ctx.cfg, "signal", ctx.accountId ?? undefined, {
    fallbackLimit: 4000,
  });
  const tableMode = resolveMarkdownTableMode({
    accountId: ctx.accountId ?? undefined,
    cfg: ctx.cfg,
    channel: "signal",
  });
  let chunks =
    limit === undefined
      ? markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, { tableMode })
      : markdownToSignalTextChunks(ctx.text, limit, { tableMode });
  if (chunks.length === 0 && ctx.text) {
    chunks = [{ styles: [], text: ctx.text }];
  }
  const results = [];
  for (const chunk of chunks) {
    ctx.abortSignal?.throwIfAborted();
    const result = await send(ctx.to, chunk.text, {
      accountId: ctx.accountId ?? undefined,
      cfg: ctx.cfg,
      maxBytes,
      textMode: "plain",
      textStyles: chunk.styles,
    });
    results.push(result);
  }
  return attachChannelToResults("signal", results);
}

async function sendFormattedSignalMedia(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string | null;
  deps?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}) {
  ctx.abortSignal?.throwIfAborted();
  const { send, maxBytes } = await resolveSignalSendContext({
    accountId: ctx.accountId ?? undefined,
    cfg: ctx.cfg,
    deps: ctx.deps,
  });
  const tableMode = resolveMarkdownTableMode({
    accountId: ctx.accountId ?? undefined,
    cfg: ctx.cfg,
    channel: "signal",
  });
  const formatted = markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, {
    tableMode,
  })[0] ?? {
    styles: [],
    text: ctx.text,
  };
  const result = await send(ctx.to, formatted.text, {
    cfg: ctx.cfg,
    mediaUrl: ctx.mediaUrl,
    mediaLocalRoots: ctx.mediaLocalRoots,
    ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
    maxBytes,
    accountId: ctx.accountId ?? undefined,
    textMode: "plain",
    textStyles: formatted.styles,
  });
  return attachChannelToResult("signal", result);
}

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount, SignalProbe> =
  createChatChannelPlugin({
    base: {
      ...createSignalPluginBase({
        setup: signalSetupAdapter,
        setupWizard: signalSetupWizard,
      }),
      actions: signalMessageActions,
      agentPrompt: {
        reactionGuidance: ({ cfg, accountId }) => {
          const level = resolveSignalReactionLevel({
            accountId: accountId ?? undefined,
            cfg,
          }).agentReactionGuidance;
          return level ? { channelLabel: "Signal", level } : undefined;
        },
      },
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "signal",
        normalize: ({ cfg, accountId, values }) =>
          signalConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
        resolveAccount: resolveSignalAccount,
        resolveDmAllowFrom: (account) => account.config.allowFrom,
        resolveDmPolicy: (account) => account.config.dmPolicy,
        resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
        resolveGroupPolicy: (account) => account.config.groupPolicy,
      }),
      approvalCapability: signalApprovalAuth,
      gateway: {
        startAccount: async (ctx) => {
          const { account } = ctx;
          ctx.setStatus({
            accountId: account.accountId,
            baseUrl: account.baseUrl,
          });
          ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
          const { monitorSignalProvider } = await loadSignalMonitorModule();
          return await monitorSignalProvider({
            abortSignal: ctx.abortSignal,
            accountId: account.accountId,
            config: ctx.cfg,
            mediaMaxMb: account.config.mediaMaxMb,
            runtime: ctx.runtime,
          });
        },
      },
      messaging: {
        inferTargetChatType: ({ to }) => inferSignalTargetChatType(to),
        normalizeTarget: normalizeSignalMessagingTarget,
        parseExplicitTarget: ({ raw }) => parseSignalExplicitTarget(raw),
        resolveOutboundSessionRoute: (params) => resolveSignalOutboundSessionRoute(params),
        targetResolver: {
          hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>",
          looksLikeId: looksLikeSignalTargetId,
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedSignalAccount, SignalProbe>({
        buildChannelSummary: ({ snapshot }) =>
          buildBaseChannelStatusSummary(snapshot, {
            baseUrl: snapshot.baseUrl ?? null,
            probe: snapshot.probe,
            lastProbeAt: snapshot.lastProbeAt ?? null,
          }),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        formatCapabilitiesProbe: ({ probe }) =>
          probe?.version ? [{ text: `Signal daemon: ${probe.version}` }] : [],
        probeAccount: async ({ account, timeoutMs }) => {
          const baseUrl = account.baseUrl;
          const { probeSignal } = await loadSignalProbeModule();
          return await probeSignal(baseUrl, timeoutMs);
        },
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            baseUrl: account.baseUrl,
          },
        }),
      }),
    },
    outbound: {
      attachedResults: {
        channel: "signal",
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          deps,
        }) =>
          await sendSignalOutbound({
            accountId: accountId ?? undefined,
            cfg,
            deps,
            mediaLocalRoots,
            mediaReadFile,
            mediaUrl,
            text,
            to,
          }),
        sendText: async ({ cfg, to, text, accountId, deps }) =>
          await sendSignalOutbound({
            accountId: accountId ?? undefined,
            cfg,
            deps,
            text,
            to,
          }),
      },
      base: {
        chunker: chunkText,
        chunkerMode: "text",
        deliveryMode: "direct",
        sendFormattedMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          deps,
          abortSignal,
        }) =>
          await sendFormattedSignalMedia({
            abortSignal,
            accountId,
            cfg,
            deps,
            mediaLocalRoots,
            mediaReadFile,
            mediaUrl,
            text,
            to,
          }),
        sendFormattedText: async ({ cfg, to, text, accountId, deps, abortSignal }) =>
          await sendFormattedSignalText({
            abortSignal,
            accountId,
            cfg,
            deps,
            text,
            to,
          }),
        textChunkLimit: 4000,
      },
    },
    pairing: {
      text: {
        idLabel: "signalNumber",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^signal:/i),
        notify: async ({ id, message }) => {
          await (await loadSignalSendRuntime()).sendMessageSignal(id, message);
        },
      },
    },
    security: signalSecurityAdapter,
  });
