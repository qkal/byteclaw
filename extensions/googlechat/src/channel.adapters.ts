import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  composeAccountWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import type { OutboundMediaLoadOptions } from "openclaw/plugin-sdk/outbound-media";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  type OpenClawConfig,
  PAIRING_APPROVED_MESSAGE,
  type ResolvedGoogleChatAccount,
  chunkTextForOutbound,
  fetchRemoteMedia,
  isGoogleChatUserTarget,
  loadOutboundMediaFromUrl,
  missingTargetError,
  normalizeGoogleChatTarget,
  resolveChannelMediaMaxBytes,
  resolveGoogleChatAccount,
  resolveGoogleChatOutboundSpace,
} from "./channel.deps.runtime.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

export const formatAllowFromEntry = (entry: string) =>
  normalizeLowercaseStringOrEmpty(
    entry
      .trim()
      .replace(/^(googlechat|google-chat|gchat):/i, "")
      .replace(/^user:/i, "")
      .replace(/^users\//i, ""),
  );

const collectGoogleChatGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedGoogleChatAccount>({
    buildOpenWarning: {
      openBehavior: "allows any space to trigger (mention-gated)",
      remediation:
        'Set channels.googlechat.groupPolicy="allowlist" and configure channels.googlechat.groups',
      surface: "Google Chat spaces",
    },
    providerConfigPresent: (cfg) => cfg.channels?.googlechat !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
  });

const collectGoogleChatSecurityWarnings = composeAccountWarningCollectors<
  ResolvedGoogleChatAccount,
  {
    cfg: OpenClawConfig;
    account: ResolvedGoogleChatAccount;
  }
>(
  collectGoogleChatGroupPolicyWarnings,
  (account) =>
    account.config.dm?.policy === "open" &&
    '- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".',
);

export const googlechatGroupsAdapter = {
  resolveRequireMention: resolveGoogleChatGroupRequireMention,
};

export const googlechatDirectoryAdapter = createChannelDirectoryAdapter({
  listGroups: async (params) =>
    listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedGoogleChatAccount>({
      ...params,
      resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
      resolveGroups: (account) => account.config.groups,
    }),
  listPeers: async (params) =>
    listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedGoogleChatAccount>({
      ...params,
      normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry,
      resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
      resolveAllowFrom: (account) => account.config.dm?.allowFrom,
    }),
});

export const googlechatSecurityAdapter = {
  collectWarnings: collectGoogleChatSecurityWarnings,
  dm: {
    allowFromPathSuffix: "dm.",
    channelKey: "googlechat",
    normalizeEntry: (raw: string) => formatAllowFromEntry(raw),
    resolveAllowFrom: (account: ResolvedGoogleChatAccount) => account.config.dm?.allowFrom,
    resolvePolicy: (account: ResolvedGoogleChatAccount) => account.config.dm?.policy,
  },
};

export const googlechatThreadingAdapter = {
  scopedAccountReplyToMode: {
    fallback: "off" as const,
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveGoogleChatAccount({ accountId, cfg }),
    resolveReplyToMode: (account: ResolvedGoogleChatAccount, _chatType?: string | null) =>
      account.config.replyToMode,
  },
};

export const googlechatPairingTextAdapter = {
  idLabel: "googlechatUserId",
  message: PAIRING_APPROVED_MESSAGE,
  normalizeAllowEntry: (entry: string) => formatAllowFromEntry(entry),
  notify: async ({
    cfg,
    id,
    message,
    accountId,
  }: {
    cfg: OpenClawConfig;
    id: string;
    message: string;
    accountId?: string | null;
  }) => {
    const account = resolveGoogleChatAccount({ accountId, cfg });
    if (account.credentialSource === "none") {
      return;
    }
    const user = normalizeGoogleChatTarget(id) ?? id;
    const target = isGoogleChatUserTarget(user) ? user : `users/${user}`;
    const space = await resolveGoogleChatOutboundSpace({ account, target });
    const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
    await sendGoogleChatMessage({
      account,
      space,
      text: message,
    });
  },
};

export const googlechatOutboundAdapter = {
  attachedResults: {
    channel: "googlechat" as const,
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      replyToId,
      threadId,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text?: string;
      mediaUrl?: string;
      mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
      mediaLocalRoots?: OutboundMediaLoadOptions["mediaLocalRoots"];
      mediaReadFile?: OutboundMediaLoadOptions["mediaReadFile"];
      accountId?: string | null;
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => {
      if (!mediaUrl) {
        throw new Error("Google Chat mediaUrl is required.");
      }
      const account = resolveGoogleChatAccount({
        cfg,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread =
        typeof threadId === "number" ? String(threadId) : (threadId ?? replyToId ?? undefined);
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          (
            cfg.channels?.googlechat as
              | { accounts?: Record<string, { mediaMaxMb?: number }>; mediaMaxMb?: number }
              | undefined
          )?.accounts?.[accountId]?.mediaMaxMb ??
          (cfg.channels?.googlechat as { mediaMaxMb?: number } | undefined)?.mediaMaxMb,
        accountId,
      });
      const effectiveMaxBytes = maxBytes ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
      const loaded = /^https?:\/\//i.test(mediaUrl)
        ? await fetchRemoteMedia({
            maxBytes: effectiveMaxBytes,
            url: mediaUrl,
          })
        : await loadOutboundMediaFromUrl(mediaUrl, {
            maxBytes: effectiveMaxBytes,
            mediaAccess,
            mediaLocalRoots,
            mediaReadFile,
          });
      const { sendGoogleChatMessage, uploadGoogleChatAttachment } =
        await loadGoogleChatChannelRuntime();
      const upload = await uploadGoogleChatAttachment({
        account,
        buffer: loaded.buffer,
        contentType: loaded.contentType,
        filename: loaded.fileName ?? "attachment",
        space,
      });
      const result = await sendGoogleChatMessage({
        account,
        attachments: upload.attachmentUploadToken
          ? [
              {
                attachmentUploadToken: upload.attachmentUploadToken,
                contentName: loaded.fileName,
              },
            ]
          : undefined,
        space,
        text,
        thread,
      });
      return {
        chatId: space,
        messageId: result?.messageName ?? "",
      };
    },
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      threadId,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => {
      const account = resolveGoogleChatAccount({
        cfg,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread =
        typeof threadId === "number" ? String(threadId) : (threadId ?? replyToId ?? undefined);
      const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
      });
      return {
        chatId: space,
        messageId: result?.messageName ?? "",
      };
    },
  },
  base: {
    chunker: chunkTextForOutbound,
    chunkerMode: "markdown" as const,
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: { to?: string }) => {
      const trimmed = normalizeOptionalString(to) ?? "";

      if (trimmed) {
        const normalized = normalizeGoogleChatTarget(trimmed);
        if (!normalized) {
          return {
            error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>"),
            ok: false as const,
          };
        }
        return { ok: true as const, to: normalized };
      }

      return {
        error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>"),
        ok: false as const,
      };
    },
    sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
    textChunkLimit: 4000,
  },
};
