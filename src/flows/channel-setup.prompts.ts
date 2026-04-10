import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelSetupPlugin } from "../channels/plugins/setup-registry.js";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import type {
  ChannelSetupDmPolicy,
  ChannelSetupWizardAdapter,
} from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DmPolicy } from "../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { formatDocsLink } from "../terminal/links.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";

export type ConfiguredChannelAction = "update" | "disable" | "delete" | "skip";

export function formatAccountLabel(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "default (primary)" : accountId;
}

export async function promptConfiguredAction(params: {
  prompter: WizardPrompter;
  label: string;
  supportsDisable: boolean;
  supportsDelete: boolean;
}): Promise<ConfiguredChannelAction> {
  const { prompter, label, supportsDisable, supportsDelete } = params;
  const options: WizardSelectOption<ConfiguredChannelAction>[] = [
    {
      label: "Modify settings",
      value: "update",
    },
    ...(supportsDisable
      ? [
          {
            label: "Disable (keeps config)",
            value: "disable" as const,
          },
        ]
      : []),
    ...(supportsDelete
      ? [
          {
            label: "Delete config",
            value: "delete" as const,
          },
        ]
      : []),
    {
      label: "Skip (leave as-is)",
      value: "skip",
    },
  ];
  return await prompter.select({
    initialValue: "update",
    message: `${label} already configured. What do you want to do?`,
    options,
  });
}

export async function promptRemovalAccountId(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  label: string;
  channel: ChannelChoice;
  plugin?: ChannelSetupPlugin;
}): Promise<string> {
  const { cfg, prompter, label, channel } = params;
  const plugin = params.plugin ?? getChannelSetupPlugin(channel);
  if (!plugin) {
    return DEFAULT_ACCOUNT_ID;
  }
  const accountIds = plugin.config.listAccountIds(cfg).filter(Boolean);
  const defaultAccountId = resolveChannelDefaultAccountId({ accountIds, cfg, plugin });
  if (accountIds.length <= 1) {
    return defaultAccountId;
  }
  const selected = await prompter.select({
    initialValue: defaultAccountId,
    message: `${label} account`,
    options: accountIds.map((accountId) => ({
      label: formatAccountLabel(accountId),
      value: accountId,
    })),
  });
  return normalizeAccountId(selected) ?? defaultAccountId;
}

export async function maybeConfigureDmPolicies(params: {
  cfg: OpenClawConfig;
  selection: ChannelChoice[];
  prompter: WizardPrompter;
  accountIdsByChannel?: Map<ChannelChoice, string>;
  resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<OpenClawConfig> {
  const { selection, prompter, accountIdsByChannel } = params;
  const resolve = params.resolveAdapter ?? (() => undefined);
  const dmPolicies = selection
    .map((channel) => resolve(channel)?.dmPolicy)
    .filter(Boolean) as ChannelSetupDmPolicy[];
  if (dmPolicies.length === 0) {
    return params.cfg;
  }

  const wants = await prompter.confirm({
    initialValue: false,
    message: "Configure DM access policies now? (default: pairing)",
  });
  if (!wants) {
    return params.cfg;
  }

  let { cfg } = params;
  for (const policy of dmPolicies) {
    const accountId = accountIdsByChannel?.get(policy.channel);
    const { policyKey, allowFromKey } = policy.resolveConfigKeys?.(cfg, accountId) ?? {
      allowFromKey: policy.allowFromKey,
      policyKey: policy.policyKey,
    };
    await prompter.note(
      [
        "Default: pairing (unknown DMs get a pairing code).",
        `Approve: ${formatCliCommand(`openclaw pairing approve ${policy.channel} <code>`)}`,
        `Allowlist DMs: ${policyKey}="allowlist" + ${allowFromKey} entries.`,
        `Public DMs: ${policyKey}="open" + ${allowFromKey} includes "*".`,
        "Multi-user DMs: run: " +
          formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
          ' (or "per-account-channel-peer" for multi-account channels) to isolate sessions.',
        `Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`,
      ].join("\n"),
      `${policy.label} DM access`,
    );
    const nextPolicy = (await prompter.select({
      message: `${policy.label} DM policy`,
      options: [
        { label: "Pairing (recommended)", value: "pairing" },
        { label: "Allowlist (specific users only)", value: "allowlist" },
        { label: "Open (public inbound DMs)", value: "open" },
        { label: "Disabled (ignore DMs)", value: "disabled" },
      ],
    })) as DmPolicy;
    const current = policy.getCurrent(cfg, accountId);
    if (nextPolicy !== current) {
      cfg = policy.setPolicy(cfg, nextPolicy, accountId);
    }
    if (nextPolicy === "allowlist" && policy.promptAllowFrom) {
      cfg = await policy.promptAllowFrom({
        accountId,
        cfg,
        prompter,
      });
    }
  }

  return cfg;
}
