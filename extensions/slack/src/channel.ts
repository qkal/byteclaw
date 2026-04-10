import {
  buildLegacyDmAccountAllowlistAdapter,
  createAccountScopedAllowlistNameResolver,
  createFlatAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import {
  adaptScopedAccountAccessor,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import {
  type RoutePeer,
  buildOutboundBaseSessionKey,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
} from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/target-resolver-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedSlackAccount,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackReplyToMode,
} from "./accounts.js";
import type { SlackActionContext } from "./action-runtime.js";
import { resolveSlackAutoThreadId } from "./action-threading.js";
import { slackApprovalCapability } from "./approval-native.js";
import { createSlackActions } from "./channel-actions.js";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  PAIRING_APPROVED_MESSAGE,
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
} from "./channel-api.js";
import { resolveSlackChannelType } from "./channel-type.js";
import { shouldSuppressLocalSlackExecApprovalPrompt } from "./exec-approvals.js";
import { resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy } from "./group-policy.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "./interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { slackOutbound } from "./outbound-adapter.js";
import type { SlackProbe } from "./probe.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";
import { getOptionalSlackRuntime, getSlackRuntime } from "./runtime.js";
import { fetchSlackScopes } from "./scopes.js";
import { collectSlackSecurityAuditFindings } from "./security-audit.js";
import { slackSetupAdapter } from "./setup-core.js";
import { slackSetupWizard } from "./setup-surface.js";
import {
  SLACK_CHANNEL,
  createSlackPluginBase,
  isSlackPluginAccountConfigured,
  slackConfigAdapter,
} from "./shared.js";
import { parseSlackTarget } from "./target-parsing.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const resolveSlackDmPolicy = createScopedDmSecurityResolver<ResolvedSlackAccount>({
  allowFromPathSuffix: "dm.",
  channelKey: "slack",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(slack|user):/i, "")
      .trim(),
  resolveAllowFrom: (account) => account.dm?.allowFrom,
  resolvePolicy: (account) => account.dm?.policy,
});

async function resolveSlackHandleAction() {
  return (
    getOptionalSlackRuntime()?.channel?.slack?.handleSlackAction ??
    (await loadSlackActionRuntime()).handleSlackAction
  );
}

function shouldTreatSlackDeliveredTextAsVisible(params: {
  kind: "tool" | "block" | "final";
  text?: string;
}): boolean {
  return (
    params.kind === "block" && typeof params.text === "string" && params.text.trim().length > 0
  );
}

// Select the appropriate Slack token for read/write operations.
function getTokenForOperation(
  account: ResolvedSlackAccount,
  operation: "read" | "write",
): string | undefined {
  const userToken = normalizeOptionalString(account.config.userToken);
  const botToken = normalizeOptionalString(account.botToken);
  const allowUserWrites = account.config.userTokenReadOnly === false;
  if (operation === "read") {
    return userToken ?? botToken;
  }
  if (!allowUserWrites) {
    return botToken;
  }
  return botToken ?? userToken;
}

type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

let slackActionRuntimePromise: Promise<typeof import("./action-runtime.runtime.js")> | undefined;
let slackSendRuntimePromise: Promise<typeof import("./send.runtime.js")> | undefined;
let slackProbeModulePromise: Promise<typeof import("./probe.js")> | undefined;
let slackMonitorModulePromise: Promise<typeof import("./monitor.js")> | undefined;
let slackDirectoryLiveModulePromise: Promise<typeof import("./directory-live.js")> | undefined;

const loadSlackDirectoryConfigModule = createLazyRuntimeModule(
  () => import("./directory-config.js"),
);
const loadSlackResolveChannelsModule = createLazyRuntimeModule(
  () => import("./resolve-channels.js"),
);
const loadSlackResolveUsersModule = createLazyRuntimeModule(() => import("./resolve-users.js"));

async function loadSlackActionRuntime() {
  slackActionRuntimePromise ??= import("./action-runtime.runtime.js");
  return await slackActionRuntimePromise;
}

async function loadSlackSendRuntime() {
  slackSendRuntimePromise ??= import("./send.runtime.js");
  return await slackSendRuntimePromise;
}

async function loadSlackProbeModule() {
  slackProbeModulePromise ??= import("./probe.js");
  return await slackProbeModulePromise;
}

async function loadSlackMonitorModule() {
  slackMonitorModulePromise ??= import("./monitor.js");
  return await slackMonitorModulePromise;
}

async function loadSlackDirectoryLiveModule() {
  slackDirectoryLiveModulePromise ??= import("./directory-live.js");
  return await slackDirectoryLiveModulePromise;
}

async function resolveSlackSendContext(params: {
  cfg: Parameters<typeof resolveSlackAccount>[0]["cfg"];
  accountId?: string;
  deps?: Record<string, unknown>;
  replyToId?: string | number | null;
  threadId?: string | number | null;
}) {
  const send =
    resolveOutboundSendDep<SlackSendFn>(params.deps, "slack") ??
    (await loadSlackSendRuntime()).sendMessageSlack;
  const account = resolveSlackAccount({ accountId: params.accountId, cfg: params.cfg });
  const token = getTokenForOperation(account, "write");
  const botToken = account.botToken?.trim();
  const tokenOverride = token && token !== botToken ? token : undefined;
  const threadTsValue = params.replyToId ?? params.threadId;
  return { send, threadTsValue, tokenOverride };
}

function parseSlackExplicitTarget(raw: string) {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  if (!target) {
    return null;
  }
  return {
    chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
    to: target.id,
  };
}

function buildSlackBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "slack" });
}

async function resolveSlackOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  replyToId?: string | null;
  threadId?: string | number | null;
}) {
  const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  let peerKind: "direct" | "channel" | "group" = isDm ? "direct" : "channel";
  if (!isDm && /^G/i.test(parsed.id)) {
    const channelType = await resolveSlackChannelType({
      accountId: params.accountId,
      cfg: params.cfg,
      channelId: parsed.id,
    });
    if (channelType === "group") {
      peerKind = "group";
    }
    if (channelType === "dm") {
      peerKind = "direct";
    }
  }
  const peer: RoutePeer = {
    id: parsed.id,
    kind: peerKind,
  };
  const baseSessionKey = buildSlackBaseSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    peer,
  });
  const threadId = normalizeOutboundThreadId(params.threadId ?? params.replyToId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    baseSessionKey,
    chatType: peerKind === "direct" ? ("direct" as const) : ("channel" as const),
    from:
      peerKind === "direct"
        ? `slack:${parsed.id}`
        : peerKind === "group"
          ? `slack:group:${parsed.id}`
          : `slack:channel:${parsed.id}`,
    peer,
    sessionKey: threadKeys.sessionKey,
    threadId,
    to: peerKind === "direct" ? `user:${parsed.id}` : `channel:${parsed.id}`,
  };
}

function formatSlackScopeDiagnostic(params: {
  tokenType: "bot" | "user";
  result: Awaited<ReturnType<typeof fetchSlackScopes>>;
}) {
  const source = params.result.source ? ` (${params.result.source})` : "";
  const label = params.tokenType === "user" ? "User scopes" : "Bot scopes";
  if (params.result.ok && params.result.scopes?.length) {
    return { text: `${label}${source}: ${params.result.scopes.join(", ")}` } as const;
  }
  return {
    text: `${label}: ${params.result.error ?? "scope lookup failed"}`,
    tone: "error",
  } as const;
}

const resolveSlackAllowlistGroupOverrides = createFlatAllowlistOverrideResolver({
  label: (key) => key,
  resolveEntries: (value) => value?.users,
  resolveRecord: (account: ResolvedSlackAccount) => account.channels,
});

const resolveSlackAllowlistNames = createAccountScopedAllowlistNameResolver({
  resolveAccount: resolveSlackAccount,
  resolveNames: async ({ token, entries }) =>
    (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({ entries, token }),
  resolveToken: (account: ResolvedSlackAccount) =>
    normalizeOptionalString(account.config.userToken) ?? normalizeOptionalString(account.botToken),
});

const collectSlackSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedSlackAccount>({
    configureRouteAllowlist: {
      groupPolicyPath: "channels.slack.groupPolicy",
      openScope: "any channel not explicitly denied",
      routeAllowlistPath: "channels.slack.channels",
      surface: "Slack channels",
    },
    missingRouteAllowlist: {
      openBehavior: "with no channel allowlist; any channel can trigger (mention-gated)",
      remediation:
        'Set channels.slack.groupPolicy="allowlist" and configure channels.slack.channels',
      surface: "Slack channels",
    },
    providerConfigPresent: (cfg) => cfg.channels?.slack !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0,
  });

export const slackPlugin: ChannelPlugin<ResolvedSlackAccount, SlackProbe> = createChatChannelPlugin<
  ResolvedSlackAccount,
  SlackProbe
>({
  base: {
    ...createSlackPluginBase({
      setup: slackSetupAdapter,
      setupWizard: slackSetupWizard,
    }),
    actions: createSlackActions(SLACK_CHANNEL, {
      invoke: async (action, cfg, toolContext) =>
        await (
          await resolveSlackHandleAction()
        )(action, cfg as OpenClawConfig, toolContext as SlackActionContext | undefined),
    }),
    allowlist: {
      ...buildLegacyDmAccountAllowlistAdapter({
        channelId: "slack",
        normalize: ({ cfg, accountId, values }) =>
          slackConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
        resolveAccount: resolveSlackAccount,
        resolveDmAllowFrom: (account) => account.config.allowFrom ?? account.config.dm?.allowFrom,
        resolveGroupOverrides: resolveSlackAllowlistGroupOverrides,
        resolveGroupPolicy: (account) => account.groupPolicy,
      }),
      resolveNames: resolveSlackAllowlistNames,
    },
    approvalCapability: slackApprovalCapability,
    directory: createChannelDirectoryAdapter({
      listGroups: async (params) =>
        (await loadSlackDirectoryConfigModule()).listSlackDirectoryGroupsFromConfig(params),
      listPeers: async (params) =>
        (await loadSlackDirectoryConfigModule()).listSlackDirectoryPeersFromConfig(params),
      ...createRuntimeDirectoryLiveAdapter({
        getRuntime: loadSlackDirectoryLiveModule,
        listGroupsLive: (runtime) => runtime.listSlackDirectoryGroupsLive,
        listPeersLive: (runtime) => runtime.listSlackDirectoryPeersLive,
      }),
    }),
    gateway: {
      startAccount: async (ctx) => {
        const { account } = ctx;
        const botToken = account.botToken?.trim();
        const appToken = account.appToken?.trim();
        ctx.log?.info(`[${account.accountId}] starting provider`);
        return (await loadSlackMonitorModule()).monitorSlackProvider({
          abortSignal: ctx.abortSignal,
          accountId: account.accountId,
          appToken: appToken ?? "",
          botToken: botToken ?? "",
          channelRuntime: ctx.channelRuntime,
          config: ctx.cfg,
          getStatus: ctx.getStatus as () => Record<string, unknown>,
          mediaMaxMb: account.config.mediaMaxMb,
          runtime: ctx.runtime,
          setStatus: ctx.setStatus as (next: Record<string, unknown>) => void,
          slashCommand: account.config.slashCommand,
        });
      },
    },
    groups: {
      resolveRequireMention: resolveSlackGroupRequireMention,
      resolveToolPolicy: resolveSlackGroupToolPolicy,
    },
    mentions: {
      stripPatterns: () => [String.raw`<@[^>\s]+>`],
    },
    messaging: {
      enableInteractiveReplies: ({ cfg, accountId }) =>
        isSlackInteractiveRepliesEnabled({ accountId, cfg }),
      hasStructuredReplyPayload: ({ payload }) => {
        try {
          return Boolean(resolveSlackReplyBlocks(payload)?.length);
        } catch {
          return false;
        }
      },
      inferTargetChatType: ({ to }) => parseSlackExplicitTarget(to)?.chatType,
      normalizeTarget: normalizeSlackMessagingTarget,
      parseExplicitTarget: ({ raw }) => parseSlackExplicitTarget(raw),
      resolveOutboundSessionRoute: async (params) => await resolveSlackOutboundSessionRoute(params),
      resolveSessionTarget: ({ id }) => normalizeSlackMessagingTarget(`channel:${id}`),
      targetResolver: {
        hint: "<channelId|user:ID|channel:ID>",
        looksLikeId: looksLikeSlackTargetId,
        resolveTarget: async ({ input }) => {
          const parsed = parseSlackExplicitTarget(input);
          if (!parsed) {
            return null;
          }
          return {
            kind: parsed.chatType === "direct" ? "user" : "group",
            source: "normalized",
            to: parsed.to,
          };
        },
      },
      transformReplyPayload: ({ payload, cfg, accountId }) =>
        isSlackInteractiveRepliesEnabled({ accountId, cfg })
          ? compileSlackInteractiveReplies(payload)
          : payload,
    },
    resolver: {
      resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
        const toResolvedTarget = <
          T extends { input: string; resolved: boolean; id?: string; name?: string },
        >(
          entry: T,
          note?: string,
        ) => ({
          id: entry.id,
          input: entry.input,
          name: entry.name,
          note,
          resolved: entry.resolved,
        });
        const account = resolveSlackAccount({ accountId, cfg });
        if (kind === "group") {
          return resolveTargetsWithOptionalToken({
            inputs,
            mapResolved: (entry) =>
              toResolvedTarget(entry, entry.archived ? "archived" : undefined),
            missingTokenNote: "missing Slack token",
            resolveWithToken: async ({ token, inputs }) =>
              (await loadSlackResolveChannelsModule()).resolveSlackChannelAllowlist({
                token,
                entries: inputs,
              }),
            token:
              normalizeOptionalString(account.config.userToken) ??
              normalizeOptionalString(account.botToken),
          });
        }
        return resolveTargetsWithOptionalToken({
          inputs,
          mapResolved: (entry) => toResolvedTarget(entry, entry.note),
          missingTokenNote: "missing Slack token",
          resolveWithToken: async ({ token, inputs }) =>
            (await loadSlackResolveUsersModule()).resolveSlackUserAllowlist({
              token,
              entries: inputs,
            }),
          token:
            normalizeOptionalString(account.config.userToken) ??
            normalizeOptionalString(account.botToken),
        });
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedSlackAccount, SlackProbe>({
      buildCapabilitiesDiagnostics: async ({ account, timeoutMs }) => {
        const lines = [];
        const details: Record<string, unknown> = {};
        const botToken = account.botToken?.trim();
        const userToken = account.config.userToken?.trim();
        const botScopes = botToken
          ? await fetchSlackScopes(botToken, timeoutMs)
          : { ok: false, error: "Slack bot token missing." };
        lines.push(formatSlackScopeDiagnostic({ tokenType: "bot", result: botScopes }));
        details.botScopes = botScopes;
        if (userToken) {
          const userScopes = await fetchSlackScopes(userToken, timeoutMs);
          lines.push(formatSlackScopeDiagnostic({ tokenType: "user", result: userScopes }));
          details.userScopes = userScopes;
        }
        return { lines, details };
      },
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveProbedChannelStatusSummary(snapshot, {
          botTokenSource: snapshot.botTokenSource ?? "none",
          appTokenSource: snapshot.appTokenSource ?? "none",
        }),
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      formatCapabilitiesProbe: ({ probe }) => {
        const slackProbe = probe as SlackProbe | undefined;
        const lines = [];
        if (slackProbe?.bot?.name) {
          lines.push({ text: `Bot: @${slackProbe.bot.name}` });
        }
        if (slackProbe?.team?.name || slackProbe?.team?.id) {
          const id = slackProbe.team?.id ? ` (${slackProbe.team.id})` : "";
          lines.push({ text: `Team: ${slackProbe.team?.name ?? "unknown"}${id}` });
        }
        return lines;
      },
      probeAccount: async ({ account, timeoutMs }) => {
        const token = account.botToken?.trim();
        if (!token) {
          return { ok: false, error: "missing token" };
        }
        return await (await loadSlackProbeModule()).probeSlack(token, timeoutMs);
      },
      resolveAccountSnapshot: ({ account }) => {
        const mode = account.config.mode ?? "socket";
        const configured =
          (mode === "http"
            ? resolveConfiguredFromRequiredCredentialStatuses(account, [
                "botTokenStatus",
                "signingSecretStatus",
              ])
            : resolveConfiguredFromRequiredCredentialStatuses(account, [
                "botTokenStatus",
                "appTokenStatus",
              ])) ?? isSlackPluginAccountConfigured(account);
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          extra: {
            ...projectCredentialSnapshotFields(account),
          },
        };
      },
    }),
  },
  outbound: {
    attachedResults: {
      channel: "slack",
      sendMedia: async ({
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        threadId,
        cfg,
      }) => {
        const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
          accountId: accountId ?? undefined,
          cfg,
          deps,
          replyToId,
          threadId,
        });
        return await send(to, text, {
          accountId: accountId ?? undefined,
          cfg,
          mediaLocalRoots,
          mediaUrl,
          threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
          ...(tokenOverride ? { token: tokenOverride } : {}),
        });
      },
      sendText: async ({ to, text, accountId, deps, replyToId, threadId, cfg }) => {
        const { send, threadTsValue, tokenOverride } = await resolveSlackSendContext({
          accountId: accountId ?? undefined,
          cfg,
          deps,
          replyToId,
          threadId,
        });
        return await send(to, text, {
          accountId: accountId ?? undefined,
          cfg,
          threadTs: threadTsValue != null ? String(threadTsValue) : undefined,
          ...(tokenOverride ? { token: tokenOverride } : {}),
        });
      },
    },
    base: {
      chunker: null,
      deliveryMode: "direct",
      sendPayload: async (ctx) => {
        const { send, tokenOverride } = await resolveSlackSendContext({
          accountId: ctx.accountId ?? undefined,
          cfg: ctx.cfg,
          deps: ctx.deps,
          replyToId: ctx.replyToId,
          threadId: ctx.threadId,
        });
        return await slackOutbound.sendPayload!({
          ...ctx,
          deps: {
            ...ctx.deps,
            slack: async (
              to: Parameters<SlackSendFn>[0],
              text: Parameters<SlackSendFn>[1],
              opts: Parameters<SlackSendFn>[2],
            ) =>
              await send(to, text, {
                ...opts,
                ...(tokenOverride ? { token: tokenOverride } : {}),
              }),
          },
        });
      },
      shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
        shouldSuppressLocalSlackExecApprovalPrompt({
          accountId,
          cfg,
          payload,
        }),
      shouldTreatDeliveredTextAsVisible: shouldTreatSlackDeliveredTextAsVisible,
      textChunkLimit: SLACK_TEXT_LIMIT,
    },
  },
  pairing: {
    text: {
      idLabel: "slackUserId",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: createPairingPrefixStripper(/^(slack|user):/i),
      notify: async ({ id, message }) => {
        const cfg = getSlackRuntime().config.loadConfig();
        const account = resolveSlackAccount({
          accountId: resolveDefaultSlackAccountId(cfg),
          cfg,
        });
        const { sendMessageSlack } = await loadSlackSendRuntime();
        const token = getTokenForOperation(account, "write");
        const botToken = account.botToken?.trim();
        const tokenOverride = token && token !== botToken ? token : undefined;
        if (tokenOverride) {
          await sendMessageSlack(`user:${id}`, message, {
            token: tokenOverride,
          });
        } else {
          await sendMessageSlack(`user:${id}`, message);
        }
      },
    },
  },
  security: {
    collectAuditFindings: collectSlackSecurityAuditFindings,
    collectWarnings: collectSlackSecurityWarnings,
    resolveDmPolicy: resolveSlackDmPolicy,
  },
  threading: {
    allowExplicitReplyTagsWhenOff: false,
    buildToolContext: (params) => buildSlackThreadingToolContext(params),
    resolveAutoThreadId: ({ to, toolContext, replyToId }) =>
      replyToId
        ? undefined
        : resolveSlackAutoThreadId({
            to,
            toolContext,
          }),
    resolveReplyTransport: ({ threadId, replyToId }) => ({
      replyToId: replyToId ?? (threadId != null && threadId !== "" ? String(threadId) : undefined),
      threadId: null,
    }),
    scopedAccountReplyToMode: {
      resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
      resolveReplyToMode: (account, chatType) => resolveSlackReplyToMode(account, chatType),
    },
  },
});
