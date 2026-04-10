import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedZalouserAccount,
  checkZcaAuthenticated,
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
import type {
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  GroupToolPolicyConfig,
  OpenClawConfig,
} from "./channel-api.js";
import {
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  isDangerousNameMatchingEnabled,
  isNumericTargetId,
  normalizeAccountId,
  sendPayloadWithChunkedTextAndMedia,
} from "./channel-api.js";
import { buildZalouserGroupCandidates, findZalouserGroupEntry } from "./group-policy.js";
import { resolveZalouserReactionMessageIds } from "./message-sid.js";
import { writeQrDataUrlToTempFile } from "./qr-temp-file.js";
import { getZalouserRuntime } from "./runtime.js";
import {
  normalizeZalouserTarget,
  parseZalouserOutboundTarget,
  resolveZalouserOutboundSessionRoute,
} from "./session-route.js";

const loadZalouserChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const ZALOUSER_TEXT_CHUNK_LIMIT = 2000;

export function resolveZalouserQrProfile(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  if (!normalized || normalized === DEFAULT_ACCOUNT_ID) {
    return process.env.ZALOUSER_PROFILE?.trim() || process.env.ZCA_PROFILE?.trim() || "default";
  }
  return normalized;
}

function resolveZalouserOutboundChunkMode(cfg: OpenClawConfig, accountId?: string) {
  return getZalouserRuntime().channel.text.resolveChunkMode(cfg, "zalouser", accountId);
}

function resolveZalouserOutboundTextChunkLimit(cfg: OpenClawConfig, accountId?: string) {
  return getZalouserRuntime().channel.text.resolveTextChunkLimit(cfg, "zalouser", accountId, {
    fallbackLimit: ZALOUSER_TEXT_CHUNK_LIMIT,
  });
}

function resolveZalouserGroupPolicyEntry(params: ChannelGroupContext) {
  const account = resolveZalouserAccountSync({
    accountId: params.accountId ?? undefined,
    cfg: params.cfg,
  });
  const groups = account.config.groups ?? {};
  return findZalouserGroupEntry(
    groups,
    buildZalouserGroupCandidates({
      allowNameMatching: isDangerousNameMatchingEnabled(account.config),
      groupChannel: params.groupChannel,
      groupId: params.groupId,
      includeWildcard: true,
    }),
  );
}

function resolveZalouserGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveZalouserGroupPolicyEntry(params)?.tools;
}

function resolveZalouserRequireMention(params: ChannelGroupContext): boolean {
  const entry = resolveZalouserGroupPolicyEntry(params);
  if (typeof entry?.requireMention === "boolean") {
    return entry.requireMention;
  }
  return true;
}

const zalouserRawSendResultAdapter = createRawChannelSendResultAdapter({
  channel: "zalouser",
  sendMedia: async ({ to, text, mediaUrl, accountId, cfg, mediaLocalRoots, mediaReadFile }) => {
    const { sendMessageZalouser } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({ cfg, accountId });
    const target = parseZalouserOutboundTarget(to);
    return await sendMessageZalouser(target.threadId, text, {
      isGroup: target.isGroup,
      mediaLocalRoots,
      mediaReadFile,
      mediaUrl,
      profile: account.profile,
      textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId),
      textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
      textMode: "markdown",
    });
  },
  sendText: async ({ to, text, accountId, cfg }) => {
    const { sendMessageZalouser } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({ cfg, accountId });
    const target = parseZalouserOutboundTarget(to);
    return await sendMessageZalouser(target.threadId, text, {
      isGroup: target.isGroup,
      profile: account.profile,
      textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId),
      textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
      textMode: "markdown",
    });
  },
});

const resolveZalouserDmPolicy = createScopedDmSecurityResolver<ResolvedZalouserAccount>({
  channelKey: "zalouser",
  normalizeEntry: (raw) => raw.trim().replace(/^(zalouser|zlu):/i, ""),
  policyPathSuffix: "dmPolicy",
  resolveAllowFrom: (account) => account.config.allowFrom,
  resolvePolicy: (account) => account.config.dmPolicy,
});

export const zalouserGroupsAdapter = {
  resolveRequireMention: resolveZalouserRequireMention,
  resolveToolPolicy: resolveZalouserGroupToolPolicy,
};

export const zalouserMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = accountId
      ? [resolveZalouserAccountSync({ accountId, cfg })].filter((account) => account.enabled)
      : listZalouserAccountIds(cfg)
          .map((resolvedAccountId) =>
            resolveZalouserAccountSync({ accountId: resolvedAccountId, cfg }),
          )
          .filter((account) => account.enabled);
    if (accounts.length === 0) {
      return null;
    }
    return { actions: ["react"] };
  },
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action !== "react") {
      throw new Error(`Zalouser action ${action} not supported`);
    }
    const { sendReactionZalouser } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({ accountId, cfg });
    const threadId =
      (typeof params.threadId === "string" ? params.threadId.trim() : "") ||
      (typeof params.to === "string" ? params.to.trim() : "") ||
      (typeof params.chatId === "string" ? params.chatId.trim() : "") ||
      (toolContext?.currentChannelId?.trim() ?? "");
    if (!threadId) {
      throw new Error("Zalouser react requires threadId (or to/chatId).");
    }
    const emoji = typeof params.emoji === "string" ? params.emoji.trim() : "";
    if (!emoji) {
      throw new Error("Zalouser react requires emoji.");
    }
    const ids = resolveZalouserReactionMessageIds({
      cliMsgId: typeof params.cliMsgId === "string" ? params.cliMsgId : undefined,
      currentMessageId: toolContext?.currentMessageId,
      messageId: typeof params.messageId === "string" ? params.messageId : undefined,
    });
    if (!ids) {
      throw new Error(
        "Zalouser react requires messageId + cliMsgId (or a current message context id).",
      );
    }
    const result = await sendReactionZalouser({
      cliMsgId: ids.cliMsgId,
      emoji,
      isGroup: params.isGroup === true,
      msgId: ids.msgId,
      profile: account.profile,
      remove: params.remove === true,
      threadId,
    });
    if (!result.ok) {
      throw new Error(result.error || "Failed to react on Zalo message");
    }
    return {
      content: [
        {
          text:
            params.remove === true
              ? `Removed reaction ${emoji} from ${ids.msgId}`
              : `Reacted ${emoji} on ${ids.msgId}`,
          type: "text" as const,
        },
      ],
      details: {
        cliMsgId: ids.cliMsgId,
        messageId: ids.msgId,
        threadId,
      },
    };
  },
  supportsAction: ({ action }) => action === "react",
};

export const zalouserResolverAdapter = {
  resolveTargets: async ({
    cfg,
    accountId,
    inputs,
    kind,
    runtime,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    inputs: string[];
    kind: "user" | "group";
    runtime: RuntimeEnv;
  }) => {
    const results = [];
    for (const input of inputs) {
      const trimmed = input.trim();
      if (!trimmed) {
        results.push({ input, note: "empty input", resolved: false });
        continue;
      }
      if (/^\d+$/.test(trimmed)) {
        results.push({ id: trimmed, input, resolved: true });
        continue;
      }
      try {
        const runtimeModule = await loadZalouserChannelRuntime();
        const account = resolveZalouserAccountSync({
          accountId: accountId ?? resolveDefaultZalouserAccountId(cfg),
          cfg,
        });
        if (kind === "user") {
          const friends = await runtimeModule.listZaloFriendsMatching(account.profile, trimmed);
          const best = friends[0];
          results.push({
            id: best?.userId,
            input,
            name: best?.displayName,
            note: friends.length > 1 ? "multiple matches; chose first" : undefined,
            resolved: Boolean(best?.userId),
          });
        } else {
          const groups = await runtimeModule.listZaloGroupsMatching(account.profile, trimmed);
          const best =
            groups.find(
              (group) =>
                normalizeLowercaseStringOrEmpty(group.name) ===
                normalizeLowercaseStringOrEmpty(trimmed),
            ) ?? groups[0];
          results.push({
            id: best?.groupId,
            input,
            name: best?.name,
            note: groups.length > 1 ? "multiple matches; chose first" : undefined,
            resolved: Boolean(best?.groupId),
          });
        }
      } catch (error) {
        runtime.error?.(`zalouser resolve failed: ${String(error)}`);
        results.push({ input, note: "lookup failed", resolved: false });
      }
    }
    return results;
  },
};

export const zalouserAuthAdapter = {
  login: async ({
    cfg,
    accountId,
    runtime,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    runtime: RuntimeEnv;
  }) => {
    const { startZaloQrLogin, waitForZaloQrLogin } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({
      accountId: accountId ?? resolveDefaultZalouserAccountId(cfg),
      cfg,
    });

    runtime.log(
      `Generating QR login for Zalo Personal (account: ${account.accountId}, profile: ${account.profile})...`,
    );

    const started = await startZaloQrLogin({
      profile: account.profile,
      timeoutMs: 35_000,
    });
    if (!started.qrDataUrl) {
      throw new Error(started.message || "Failed to start QR login");
    }

    const qrPath = await writeQrDataUrlToTempFile(started.qrDataUrl, account.profile);
    if (qrPath) {
      runtime.log(`Scan QR image: ${qrPath}`);
    } else {
      runtime.log("QR generated but could not be written to a temp file.");
    }

    const waited = await waitForZaloQrLogin({ profile: account.profile, timeoutMs: 180_000 });
    if (!waited.connected) {
      throw new Error(waited.message || "Zalouser login failed");
    }

    runtime.log(waited.message);
  },
};

export const zalouserSecurityAdapter = {
  collectAuditFindings: async (params: {
    accountId?: string | null;
    account: ResolvedZalouserAccount;
    orderedAccountIds: string[];
    hasExplicitAccountPath: boolean;
  }) => (await loadZalouserChannelRuntime()).collectZalouserSecurityAuditFindings(params),
  resolveDmPolicy: resolveZalouserDmPolicy,
};

export const zalouserThreadingAdapter = {
  resolveReplyToMode: createStaticReplyToModeResolver("off"),
};

export const zalouserPairingTextAdapter = {
  idLabel: "zalouserUserId",
  message: "Your pairing request has been approved.",
  normalizeAllowEntry: createPairingPrefixStripper(/^(zalouser|zlu):/i),
  notify: async ({ cfg, id, message }: { cfg: OpenClawConfig; id: string; message: string }) => {
    const { sendMessageZalouser } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({ cfg });
    const authenticated = await checkZcaAuthenticated(account.profile);
    if (!authenticated) {
      throw new Error("Zalouser not authenticated");
    }
    await sendMessageZalouser(id, message, {
      profile: account.profile,
    });
  },
};

export const zalouserOutboundAdapter = {
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  deliveryMode: "direct" as const,
  sendPayload: async (
    ctx: { payload: object } & Parameters<
      NonNullable<typeof zalouserRawSendResultAdapter.sendText>
    >[0],
  ) =>
    await sendPayloadWithChunkedTextAndMedia({
      ctx,
      emptyResult: createEmptyChannelResult("zalouser"),
      sendMedia: (nextCtx) => zalouserRawSendResultAdapter.sendMedia!(nextCtx),
      sendText: (nextCtx) => zalouserRawSendResultAdapter.sendText!(nextCtx),
    }),
  ...zalouserRawSendResultAdapter,
};

export const zalouserMessagingAdapter = {
  normalizeTarget: (raw: string) => normalizeZalouserTarget(raw),
  resolveOutboundSessionRoute: (
    params: Parameters<typeof resolveZalouserOutboundSessionRoute>[0],
  ) => resolveZalouserOutboundSessionRoute(params),
  targetResolver: {
    hint: "<user:id|group:id>",
    looksLikeId: (raw: string) => {
      const normalized = normalizeZalouserTarget(raw);
      if (!normalized) {
        return false;
      }
      if (/^group:[^\s]+$/i.test(normalized) || /^user:[^\s]+$/i.test(normalized)) {
        return true;
      }
      return isNumericTargetId(normalized);
    },
  },
};
