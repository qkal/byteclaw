import type { ChannelSetupAdapter, ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  type ChannelSetupDmPolicy,
  type WizardPrompter,
  createSetupInputPresenceValidator,
  mergeAllowFromEntries,
  promptParsedAllowFromForAccount,
  resolveSetupAccountId,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { applyAccountNameToChannelSection, patchScopedAccountConfig } from "../runtime-api.js";
import { resolveDefaultNextcloudTalkAccountId, resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

const channel = "nextcloud-talk" as const;

type NextcloudSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  secret?: string;
  secretFile?: string;
};
type NextcloudTalkSection = NonNullable<CoreConfig["channels"]>["nextcloud-talk"];

function addWildcardAllowFrom(allowFrom?: (string | number)[] | null): string[] {
  return mergeAllowFromEntries(allowFrom, ["*"]);
}

export function normalizeNextcloudTalkBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function validateNextcloudTalkBaseUrl(value: string): string | undefined {
  if (!value) {
    return "Required";
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return "URL must start with http:// or https://";
  }
  return undefined;
}

export function setNextcloudTalkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  updates: Record<string, unknown>,
): CoreConfig {
  return patchScopedAccountConfig({
    accountId,
    cfg,
    channelKey: channel,
    patch: updates,
  }) as CoreConfig;
}

export function clearNextcloudTalkAccountFields(
  cfg: CoreConfig,
  accountId: string,
  fields: string[],
): CoreConfig {
  const section = cfg.channels?.["nextcloud-talk"];
  if (!section) {
    return cfg;
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextSection = { ...section } as Record<string, unknown>;
    for (const field of fields) {
      delete nextSection[field];
    }
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "nextcloud-talk": nextSection as NextcloudTalkSection,
      },
    } as CoreConfig;
  }

  const currentAccount = section.accounts?.[accountId];
  if (!currentAccount) {
    return cfg;
  }

  const nextAccount = { ...currentAccount } as Record<string, unknown>;
  for (const field of fields) {
    delete nextAccount[field];
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "nextcloud-talk": {
        ...section,
        accounts: {
          ...section.accounts,
          [accountId]: nextAccount as NonNullable<typeof section.accounts>[string],
        },
      },
    },
  } as CoreConfig;
}

async function promptNextcloudTalkAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  return await promptParsedAllowFromForAccount({
    accountId: params.accountId,
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setNextcloudTalkAccountConfig(cfg, accountId, {
        allowFrom,
        dmPolicy: "allowlist",
      }),
    cfg: params.cfg,
    defaultAccountId: params.accountId,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveNextcloudTalkAccount({ accountId, cfg }).config.allowFrom ?? [],
    mergeEntries: ({ existing, parsed }) =>
      mergeAllowFromEntries(
        existing.map((value) => normalizeLowercaseStringOrEmpty(String(value))),
        parsed,
      ),
    message: "Nextcloud Talk allowFrom (user id)",
    noteLines: [
      "1) Check the Nextcloud admin panel for user IDs",
      "2) Or look at the webhook payload logs when someone messages",
      "3) User IDs are typically lowercase usernames in Nextcloud",
      `Docs: ${formatDocsLink("/channels/nextcloud-talk", "nextcloud-talk")}`,
    ],
    noteTitle: "Nextcloud Talk user id",
    parseEntries: (raw) => ({
      entries: String(raw)
        .split(/[\n,;]+/g)
        .map(normalizeLowercaseStringOrEmpty)
        .filter(Boolean),
    }),
    placeholder: "username",
    prompter: params.prompter,
  });
}

async function promptNextcloudTalkAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultNextcloudTalkAccountId(params.cfg as CoreConfig),
  });
  return await promptNextcloudTalkAllowFrom({
    accountId,
    cfg: params.cfg as CoreConfig,
    prompter: params.prompter,
  });
}

export const nextcloudTalkDmPolicy: ChannelSetupDmPolicy = {
  allowFromKey: "channels.nextcloud-talk.allowFrom",
  channel,
  getCurrent: (cfg, accountId) =>
    resolveNextcloudTalkAccount({
      accountId: accountId ?? resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig),
      cfg: cfg as CoreConfig,
    }).config.dmPolicy ?? "pairing",
  label: "Nextcloud Talk",
  policyKey: "channels.nextcloud-talk.dmPolicy",
  promptAllowFrom: promptNextcloudTalkAllowFromForAccount,
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig)) !== DEFAULT_ACCOUNT_ID
      ? {
          allowFromKey: `channels.nextcloud-talk.accounts.${accountId ?? resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig)}.allowFrom`,
          policyKey: `channels.nextcloud-talk.accounts.${accountId ?? resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig)}.dmPolicy`,
        }
      : {
          allowFromKey: "channels.nextcloud-talk.allowFrom",
          policyKey: "channels.nextcloud-talk.dmPolicy",
        },
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId = accountId ?? resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig);
    const resolved = resolveNextcloudTalkAccount({
      accountId: resolvedAccountId,
      cfg: cfg as CoreConfig,
    });
    return setNextcloudTalkAccountConfig(cfg as CoreConfig, resolvedAccountId, {
      dmPolicy: policy,
      ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}),
    });
  },
};

export const nextcloudTalkSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as NextcloudSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      accountId,
      cfg,
      channelKey: channel,
      name: setupInput.name,
    });
    const next = setupInput.useEnv
      ? clearNextcloudTalkAccountFields(namedConfig as CoreConfig, accountId, [
          "botSecret",
          "botSecretFile",
        ])
      : namedConfig;
    const patch = {
      baseUrl: normalizeNextcloudTalkBaseUrl(setupInput.baseUrl),
      ...(setupInput.useEnv
        ? {}
        : setupInput.secretFile
          ? { botSecretFile: setupInput.secretFile }
          : setupInput.secret
            ? { botSecret: setupInput.secret }
            : {}),
    };
    return setNextcloudTalkAccountConfig(next as CoreConfig, accountId, patch);
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      accountId,
      cfg,
      channelKey: channel,
      name,
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.",
    validate: ({ input }) => {
      const setupInput = input as NextcloudSetupInput;
      if (!setupInput.useEnv && !setupInput.secret && !setupInput.secretFile) {
        return "Nextcloud Talk requires bot secret or --secret-file (or --use-env).";
      }
      if (!setupInput.baseUrl) {
        return "Nextcloud Talk requires --base-url.";
      }
      return null;
    },
  }),
};
