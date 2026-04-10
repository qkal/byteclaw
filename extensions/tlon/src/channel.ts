import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { type ChannelPlugin, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { tlonChannelConfigSchema } from "./config-schema.js";
import { tlonDoctor } from "./doctor.js";
import { resolveTlonOutboundSessionRoute } from "./session-route.js";
import { createTlonSetupWizardBase, tlonSetupAdapter } from "./setup-core.js";
import {
  formatTargetHint,
  normalizeShip,
  parseTlonTarget,
  resolveTlonOutboundTarget,
} from "./targets.js";
import { listTlonAccountIds, resolveTlonAccount } from "./types.js";

const TLON_CHANNEL_ID = "tlon" as const;

const loadTlonChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const tlonSetupWizardProxy = createTlonSetupWizardBase({
  finalize: async (params) =>
    await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.finalize!(params),
  resolveConfigured: async ({ cfg, accountId }) =>
    await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.status.resolveConfigured({
      accountId,
      cfg,
    }),
  resolveStatusLines: async ({ cfg, accountId, configured }) =>
    (await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.status.resolveStatusLines?.({
      accountId,
      cfg,
      configured,
    })) ?? [],
}) satisfies NonNullable<ChannelPlugin["setupWizard"]>;

const tlonConfigAdapter = createHybridChannelConfigAdapter({
  clearBaseFields: ["ship", "code", "url", "name"],
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => normalizeShip(String(entry))).filter(Boolean),
  listAccountIds: listTlonAccountIds,
  preserveSectionOnDefaultDelete: true,
  resolveAccount: resolveTlonAccount,
  resolveAllowFrom: (account) => account.dmAllowlist,
  sectionKey: TLON_CHANNEL_ID,
});

export const tlonPlugin = createChatChannelPlugin({
  base: {
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      media: true,
      reply: true,
      threads: true,
    },
    config: {
      ...tlonConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            ship: account.ship,
            url: account.url,
          },
        }),
      isConfigured: (account) => account.configured,
    },
    configSchema: tlonChannelConfigSchema,
    doctor: tlonDoctor,
    gateway: {
      startAccount: async (ctx) =>
        await (await loadTlonChannelRuntime()).startTlonGatewayAccount(ctx),
    },
    id: TLON_CHANNEL_ID,
    messaging: {
      normalizeTarget: (target) => {
        const parsed = parseTlonTarget(target);
        if (!parsed) {
          return target.trim();
        }
        if (parsed.kind === "dm") {
          return parsed.ship;
        }
        return parsed.nest;
      },
      resolveOutboundSessionRoute: (params) => resolveTlonOutboundSessionRoute(params),
      targetResolver: {
        hint: formatTargetHint(),
        looksLikeId: (target) => Boolean(parseTlonTarget(target)),
      },
    },
    meta: {
      aliases: ["urbit"],
      blurb: "Decentralized messaging on Urbit",
      docsLabel: "tlon",
      docsPath: "/channels/tlon",
      id: TLON_CHANNEL_ID,
      label: "Tlon",
      order: 90,
      selectionLabel: "Tlon (Urbit)",
    },
    reload: { configPrefixes: ["channels.tlon"] },
    setup: tlonSetupAdapter,
    setupWizard: tlonSetupWizardProxy,
    status: createComputedAccountStatusAdapter<ReturnType<typeof resolveTlonAccount>>({
      buildChannelSummary: ({ snapshot }) => {
        const s = snapshot as { configured?: boolean; ship?: string; url?: string };
        return {
          configured: s.configured ?? false,
          ship: s.ship ?? null,
          url: s.url ?? null,
        };
      },
      collectStatusIssues: (accounts) => {
        return accounts.flatMap((account) => {
          if (!account.configured) {
            return [
              {
                channel: TLON_CHANNEL_ID,
                accountId: account.accountId,
                kind: "config",
                message: "Account not configured (missing ship, code, or url)",
              },
            ];
          }
          return [];
        });
      },
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      probeAccount: async ({ account }) => {
        if (!account.configured || !account.ship || !account.url || !account.code) {
          return { ok: false, error: "Not configured" };
        }
        return await (await loadTlonChannelRuntime()).probeTlonAccount(account as never);
      },
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name ?? undefined,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          ship: account.ship,
          url: account.url,
        },
      }),
    }),
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => resolveTlonOutboundTarget(to),
    textChunkLimit: 10_000,
    ...createRuntimeOutboundDelegates({
      getRuntime: loadTlonChannelRuntime,
      sendMedia: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendMedia },
      sendText: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendText },
    }),
  },
});
