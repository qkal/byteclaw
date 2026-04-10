import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  formatPairingApproveHint,
} from "./channel-api.js";
import type { NostrProfile } from "./config-schema.js";
import { NostrConfigSchema } from "./config-schema.js";
import {
  getActiveNostrBuses,
  nostrOutboundAdapter,
  nostrPairingTextAdapter,
  startNostrGatewayAccount,
} from "./gateway.js";
import { normalizePubkey } from "./nostr-bus.js";
import type { ProfilePublishResult } from "./nostr-profile.js";
import { resolveNostrOutboundSessionRoute } from "./session-route.js";
import { nostrSetupAdapter, nostrSetupWizard } from "./setup-surface.js";
import {
  type ResolvedNostrAccount,
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
} from "./types.js";

const resolveNostrDmPolicy = createScopedDmSecurityResolver<ResolvedNostrAccount>({
  approveHint: formatPairingApproveHint("nostr"),
  channelKey: "nostr",
  defaultPolicy: "pairing",
  normalizeEntry: (raw) => {
    try {
      return normalizePubkey(raw.trim().replace(/^nostr:/i, ""));
    } catch {
      return raw.trim();
    }
  },
  policyPathSuffix: "dmPolicy",
  resolveAllowFrom: (account) => account.config.allowFrom,
  resolvePolicy: (account) => account.config.dmPolicy,
});

const nostrConfigAdapter = createTopLevelChannelConfigAdapter<ResolvedNostrAccount>({
  clearBaseFields: [
    "name",
    "defaultAccount",
    "privateKey",
    "relays",
    "dmPolicy",
    "allowFrom",
    "profile",
  ],
  defaultAccountId: resolveDefaultNostrAccountId,
  deleteMode: "clear-fields",
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => {
        if (entry === "*") {
          return "*";
        }
        try {
          return normalizePubkey(entry);
        } catch {
          return entry;
        }
      })
      .filter(Boolean),
  listAccountIds: listNostrAccountIds,
  resolveAccount: (cfg) => resolveNostrAccount({ cfg }),
  resolveAllowFrom: (account) => account.config.allowFrom,
  sectionKey: "nostr",
});

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = createChatChannelPlugin({
  base: {
    capabilities: {
      chatTypes: ["direct"], // DMs only for MVP
      media: false, // No media for MVP
    },
    config: {
      ...nostrConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
          },
        }),
      isConfigured: (account) => account.configured,
    },
    configSchema: buildChannelConfigSchema(NostrConfigSchema),
    gateway: {
      startAccount: startNostrGatewayAccount,
    },
    id: "nostr",
    messaging: {
      normalizeTarget: (target) => {
        // Strip nostr: prefix if present
        const cleaned = target.trim().replace(/^nostr:/i, "");
        try {
          return normalizePubkey(cleaned);
        } catch {
          return cleaned;
        }
      },
      resolveOutboundSessionRoute: (params) => resolveNostrOutboundSessionRoute(params),
      targetResolver: {
        hint: "<npub|hex pubkey|nostr:npub...>",
        looksLikeId: (input) => {
          const trimmed = input.trim();
          return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
        },
      },
    },
    meta: {
      blurb: "Decentralized DMs via Nostr relays (NIP-04)",
      docsLabel: "nostr",
      docsPath: "/channels/nostr",
      id: "nostr",
      label: "Nostr",
      order: 100,
      selectionLabel: "Nostr",
    },
    reload: { configPrefixes: ["channels.nostr"] },
    setup: nostrSetupAdapter,
    setupWizard: nostrSetupWizard,
    status: {
      ...createComputedAccountStatusAdapter<ResolvedNostrAccount>({
        buildChannelSummary: ({ snapshot }) =>
          buildPassiveChannelStatusSummary(snapshot, {
            publicKey: snapshot.publicKey ?? null,
          }),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
            profile: account.profile,
            ...buildTrafficStatusSummary(runtime),
          },
        }),
      }),
    },
  },
  outbound: nostrOutboundAdapter,
  pairing: {
    text: nostrPairingTextAdapter,
  },
  security: {
    resolveDmPolicy: resolveNostrDmPolicy,
  },
});

/**
 * Publish a profile (kind:0) for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @param profile - Profile data to publish
 * @returns Publish results with successes and failures
 * @throws Error if account is not running
 */
export async function publishNostrProfile(
  accountId: string = DEFAULT_ACCOUNT_ID,
  profile: NostrProfile,
): Promise<ProfilePublishResult> {
  const bus = getActiveNostrBuses().get(accountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${accountId}`);
  }
  return bus.publishProfile(profile);
}

/**
 * Get profile publish state for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @returns Profile publish state or null if account not running
 */
export async function getNostrProfileState(accountId: string = DEFAULT_ACCOUNT_ID): Promise<{
  lastPublishedAt: number | null;
  lastPublishedEventId: string | null;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
} | null> {
  const bus = getActiveNostrBuses().get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}

export { getActiveNostrBuses, getNostrMetrics } from "./gateway.js";
