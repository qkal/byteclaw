import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { initApiConfig } from "./api.js";
import { qqbotConfigAdapter, qqbotMeta, qqbotSetupAdapterShared } from "./channel-config-shared.js";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "./config.js";
import { getQQBotRuntime } from "./runtime.js";
import { qqbotSetupWizard } from "./setup-surface.js";
// Re-export text helpers so existing consumers of channel.ts are unaffected.
// The canonical definition lives in text-utils.ts to avoid a circular
// Dependency: channel.ts → (dynamic) gateway.ts → outbound-deliver.ts → channel.ts.
export { chunkText, TEXT_CHUNK_LIMIT } from "./text-utils.js";
import type { ResolvedQQBotAccount } from "./types.js";

// Shared promise so concurrent multi-account startups serialize the dynamic
// Import of the gateway module, avoiding an ESM circular-dependency race.
let _gatewayModulePromise: Promise<typeof import("./gateway.js")> | undefined;
function loadGatewayModule(): Promise<typeof import("./gateway.js")> {
  _gatewayModulePromise ??= import("./gateway.js");
  return _gatewayModulePromise;
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    /**
     * BlockStreaming=true means the channel supports block streaming.
     * The framework collects streamed blocks and sends them through deliver().
     */
    blockStreaming: true,
  },
  config: {
    ...qqbotConfigAdapter,
  },
  configSchema: qqbotChannelConfigSchema,
  gateway: {
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
      let cleared = false;
      let changed = false;

      if (nextQQBot) {
        const qqbot = nextQQBot as Record<string, unknown>;
        if (accountId === DEFAULT_ACCOUNT_ID) {
          if (qqbot.clientSecret) {
            delete qqbot.clientSecret;
            cleared = true;
            changed = true;
          }
          if (qqbot.clientSecretFile) {
            delete qqbot.clientSecretFile;
            cleared = true;
            changed = true;
          }
        }
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId] as Record<string, unknown> | undefined;
          if (entry && "clientSecret" in entry) {
            delete entry.clientSecret;
            cleared = true;
            changed = true;
          }
          if (entry && "clientSecretFile" in entry) {
            delete entry.clientSecretFile;
            cleared = true;
            changed = true;
          }
          if (entry && Object.keys(entry).length === 0) {
            delete accounts[accountId];
            changed = true;
          }
        }
      }

      if (changed && nextQQBot) {
        nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as {
          writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
        };
        await configApi.writeConfigFile(nextCfg);
      }

      const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);

      return { cleared, envToken, loggedOut, ok: true };
    },
    startAccount: async (ctx) => {
      const { account } = ctx;
      const { abortSignal, log, cfg } = ctx;
      // Serialize the dynamic import so concurrent multi-account startups
      // Do not hit an ESM circular-dependency race where the gateway chunk's
      // Transitive imports have not finished evaluating yet.
      const { startGateway } = await loadGatewayModule();

      log?.info(
        `[qqbot:${account.accountId}] Starting gateway — appId=${account.appId}, enabled=${account.enabled}, name=${account.name ?? "unnamed"}`,
      );

      await startGateway({
        abortSignal,
        account,
        cfg,
        log,
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
      });
    },
  },
  id: "qqbot",
  messaging: {
    /** Normalize common QQ Bot target formats into the canonical qqbot:... form. */
    normalizeTarget: (target: string): string | undefined => {
      const id = target.replace(/^qqbot:/i, "");
      if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
        return `qqbot:${id}`;
      }
      const openIdHexPattern = /^[0-9a-fA-F]{32}$/;
      if (openIdHexPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }
      const openIdUuidPattern =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (openIdUuidPattern.test(id)) {
        return `qqbot:c2c:${id}`;
      }

      return undefined;
    },
    targetResolver: {
      /** Return true when the id looks like a QQ Bot target. */
      hint: "QQ Bot target format: qqbot:c2c:openid (direct) or qqbot:group:groupid (group)",
      looksLikeId: (id: string): boolean => {
        if (/^qqbot:(c2c|group|channel):/i.test(id)) {
          return true;
        }
        if (/^(c2c|group|channel):/i.test(id)) {
          return true;
        }
        if (/^[0-9a-fA-F]{32}$/.test(id)) {
          return true;
        }
        const openIdPattern =
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        return openIdPattern.test(id);
      },
    },
  },

  meta: {
    ...qqbotMeta,
  },
  outbound: {
    chunker: (text, limit) => getQQBotRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    deliveryMode: "direct",
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendMedia } = await import("./outbound.js");
      initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
      const result = await sendMedia({
        account,
        accountId,
        mediaUrl: mediaUrl ?? "",
        replyToId,
        text: text ?? "",
        to,
      });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const { sendText } = await import("./outbound.js");
      initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
      const result = await sendText({ account, accountId, replyToId, text, to });
      return {
        channel: "qqbot" as const,
        messageId: result.messageId ?? "",
        meta: result.error ? { error: result.error } : undefined,
      };
    },
    textChunkLimit: 5000,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  setup: {
    ...qqbotSetupAdapterShared,
  },
  setupWizard: qqbotSetupWizard,
  status: {
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      configured: Boolean(account?.appId && account?.clientSecret),
      connected: runtime?.connected ?? false,
      enabled: account?.enabled ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      name: account?.name,
      running: runtime?.running ?? false,
      tokenSource: account?.secretSource,
    }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
      running: snapshot.running ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
    }),
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      running: false,
    },
  },
};
