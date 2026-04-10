import {
  type ChannelSetupAdapter,
  type ChannelSetupInput,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createSetupInputPresenceValidator,
  formatDocsLink,
  normalizeAccountId,
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
} from "openclaw/plugin-sdk/setup";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { buildTlonAccountFields } from "./account-fields.js";
import { normalizeShip } from "./targets.js";
import { type TlonResolvedAccount, listTlonAccountIds, resolveTlonAccount } from "./types.js";
import { validateUrbitBaseUrl } from "./urbit/base-url.js";

function tlonChannelId() {
  return "tlon" as const;
}

export type TlonSetupInput = ChannelSetupInput & {
  ship?: string;
  url?: string;
  code?: string;
  dangerouslyAllowPrivateNetwork?: boolean;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
  ownerShip?: string;
};

function isConfigured(account: TlonResolvedAccount): boolean {
  return Boolean(account.ship && account.url && account.code);
}

interface TlonSetupWizardBaseParams {
  resolveConfigured: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => boolean | Promise<boolean>;
  resolveStatusLines?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    configured: boolean;
  }) => string[] | Promise<string[]>;
  finalize: NonNullable<ChannelSetupWizard["finalize"]>;
}

export function createTlonSetupWizardBase(params: TlonSetupWizardBaseParams): ChannelSetupWizard {
  return {
    channel: tlonChannelId(),
    credentials: [],
    finalize: params.finalize,
    introNote: {
      lines: [
        "You need your Urbit ship URL and login code.",
        "Example URL: https://your-ship-host",
        "Example ship: ~sampel-palnet",
        "If your ship URL is on a private network (LAN/localhost), you must explicitly allow it during setup.",
        `Docs: ${formatDocsLink("/channels/tlon", "channels/tlon")}`,
      ],
      title: "Tlon setup",
    },
    status: {
      configuredHint: "configured",
      configuredLabel: "configured",
      configuredScore: 1,
      resolveConfigured: ({ cfg, accountId }) => params.resolveConfigured({ accountId, cfg }),
      resolveStatusLines: ({ cfg, accountId, configured }) =>
        params.resolveStatusLines?.({ accountId, cfg, configured }) ?? [],
      unconfiguredHint: "urbit messenger",
      unconfiguredLabel: "needs setup",
      unconfiguredScore: 4,
    },
    textInputs: [
      {
        applySet: async ({ cfg, accountId, value }) =>
          applyTlonSetupConfig({
            cfg,
            accountId,
            input: { ship: value },
          }),
        currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).ship ?? undefined,
        inputKey: "ship",
        message: "Ship name",
        normalizeValue: ({ value }) =>
          normalizeShip(normalizeStringifiedOptionalString(value) ?? ""),
        placeholder: "~sampel-palnet",
        validate: ({ value }) =>
          normalizeStringifiedOptionalString(value) ? undefined : "Required",
      },
      {
        applySet: async ({ cfg, accountId, value }) =>
          applyTlonSetupConfig({
            cfg,
            accountId,
            input: { url: value },
          }),
        currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).url ?? undefined,
        inputKey: "url",
        message: "Ship URL",
        normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
        placeholder: "https://your-ship-host",
        validate: ({ value }) => {
          const next = validateUrbitBaseUrl(String(value ?? ""));
          if (!next.ok) {
            return next.error;
          }
          return undefined;
        },
      },
      {
        applySet: async ({ cfg, accountId, value }) =>
          applyTlonSetupConfig({
            cfg,
            accountId,
            input: { code: value },
          }),
        currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).code ?? undefined,
        inputKey: "code",
        message: "Login code",
        normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
        placeholder: "lidlut-tabwed-pillex-ridrup",
        validate: ({ value }) =>
          normalizeStringifiedOptionalString(value) ? undefined : "Required",
      },
    ],
  };
}

export async function resolveTlonSetupConfigured(
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<boolean> {
  if (accountId) {
    return isConfigured(resolveTlonAccount(cfg, accountId));
  }
  const accountIds = listTlonAccountIds(cfg);
  return accountIds.length > 0
    ? accountIds.some((resolvedAccountId) =>
        isConfigured(resolveTlonAccount(cfg, resolvedAccountId)),
      )
    : isConfigured(resolveTlonAccount(cfg, DEFAULT_ACCOUNT_ID));
}

export async function resolveTlonSetupStatusLines(
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<string[]> {
  const configured = await resolveTlonSetupConfigured(cfg, accountId);
  const label = accountId && accountId !== DEFAULT_ACCOUNT_ID ? `Tlon (${accountId})` : "Tlon";
  return [`${label}: ${configured ? "configured" : "needs setup"}`];
}

export function applyTlonSetupConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: TlonSetupInput;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;
  const namedConfig = prepareScopedSetupConfig({
    accountId,
    cfg,
    channelKey: tlonChannelId(),
    name: input.name,
  });
  const base = namedConfig.channels?.tlon ?? {};
  const payload = buildTlonAccountFields(input);

  if (useDefault) {
    return {
      ...namedConfig,
      channels: {
        ...namedConfig.channels,
        tlon: {
          ...base,
          enabled: true,
          ...payload,
        },
      },
    };
  }

  return patchScopedAccountConfig({
    accountId,
    accountPatch: {
      enabled: true,
      ...payload,
    },
    cfg: namedConfig,
    channelKey: tlonChannelId(),
    ensureAccountEnabled: false,
    ensureChannelEnabled: false,
    patch: { enabled: base.enabled ?? true },
  });
}

export const tlonSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) =>
    applyTlonSetupConfig({
      accountId,
      cfg,
      input: input as TlonSetupInput,
    }),
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      accountId,
      cfg,
      channelKey: tlonChannelId(),
      name,
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  validateInput: createSetupInputPresenceValidator({
    validate: ({ cfg, accountId, input }) => {
      const resolved = resolveTlonAccount(cfg, accountId ?? undefined);
      const ship = normalizeOptionalString(input.ship) || resolved.ship;
      const url = normalizeOptionalString(input.url) || resolved.url;
      const code = normalizeOptionalString(input.code) || resolved.code;
      if (!ship) {
        return "Tlon requires --ship.";
      }
      if (!url) {
        return "Tlon requires --url.";
      }
      if (!code) {
        return "Tlon requires --code.";
      }
      return null;
    },
  }),
};
