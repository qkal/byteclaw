import type {
  ChannelSetupAdapter,
  ChannelSetupWizard,
  ChannelSetupWizardTextInput,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  type OpenClawConfig,
  type WizardPrompter,
  createCliPathTextInput,
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  createPatchedAccountSetupAdapter,
  mergeAllowFromEntries,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultIMessageAccountId, resolveIMessageAccount } from "./accounts.js";
import { normalizeIMessageHandle } from "./targets.js";

const channel = "imessage" as const;

export function parseIMessageAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    const lower = normalizeLowercaseStringOrEmpty(entry);
    if (lower.startsWith("chat_id:")) {
      const id = entry.slice("chat_id:".length).trim();
      if (!/^\d+$/.test(id)) {
        return { error: `Invalid chat_id: ${entry}` };
      }
      return { value: entry };
    }
    if (lower.startsWith("chat_guid:")) {
      if (!entry.slice("chat_guid:".length).trim()) {
        return { error: "Invalid chat_guid entry" };
      }
      return { value: entry };
    }
    if (lower.startsWith("chat_identifier:")) {
      if (!entry.slice("chat_identifier:".length).trim()) {
        return { error: "Invalid chat_identifier entry" };
      }
      return { value: entry };
    }
    if (!normalizeIMessageHandle(entry)) {
      return { error: `Invalid handle: ${entry}` };
    }
    return { value: entry };
  });
}

function buildIMessageSetupPatch(input: {
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
}) {
  return {
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.dbPath ? { dbPath: input.dbPath } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.region ? { region: input.region } : {}),
  };
}

export async function promptIMessageAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    accountId: params.accountId,
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({
        accountId,
        allowFrom,
        cfg,
        channel,
      }),
    cfg: params.cfg,
    defaultAccountId: resolveDefaultIMessageAccountId(params.cfg),
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveIMessageAccount({ accountId, cfg }).config.allowFrom ?? [],
    message: "iMessage allowFrom (handle or chat_id)",
    noteLines: [
      "Allowlist iMessage DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:... or chat_identifier:...",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/imessage", "imessage")}`,
    ],
    noteTitle: "iMessage allowlist",
    parseEntries: parseIMessageAllowFromEntries,
    placeholder: "+15555550123, user@example.com, chat_id:123",
    prompter: params.prompter,
  });
}

export const imessageDmPolicy = {
  allowFromKey: "channels.imessage.allowFrom",
  channel,
  getCurrent: (cfg: OpenClawConfig, accountId?: string) => {
    const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(cfg);
    return resolveIMessageAccount({ accountId: targetAccountId, cfg }).config.dmPolicy ?? "pairing";
  },
  label: "iMessage",
  policyKey: "channels.imessage.dmPolicy",
  promptAllowFrom: promptIMessageAllowFrom,
  resolveConfigKeys: (_cfg: OpenClawConfig, accountId?: string) => {
    const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(_cfg);
    return targetAccountId !== "default"
      ? {
          allowFromKey: `channels.imessage.accounts.${targetAccountId}.allowFrom`,
          policyKey: `channels.imessage.accounts.${targetAccountId}.dmPolicy`,
        }
      : {
          allowFromKey: "channels.imessage.allowFrom",
          policyKey: "channels.imessage.dmPolicy",
        };
  },
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) => {
    const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(cfg);
    return patchChannelConfigForAccount({
      accountId: targetAccountId,
      cfg,
      channel,
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveIMessageAccount({ cfg, accountId: targetAccountId }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    });
  },
};

function resolveIMessageCliPath(params: { cfg: OpenClawConfig; accountId: string }) {
  return resolveIMessageAccount(params).config.cliPath ?? "imsg";
}

export function createIMessageCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return createCliPathTextInput({
    helpLines: ["imsg CLI path required to enable iMessage."],
    helpTitle: "iMessage",
    inputKey: "cliPath",
    message: "imsg CLI path",
    resolvePath: ({ cfg, accountId }) => resolveIMessageCliPath({ accountId, cfg }),
    shouldPrompt,
  });
}

export const imessageCompletionNote = {
  lines: [
    "This is still a work in progress.",
    "Ensure OpenClaw has Full Disk Access to Messages DB.",
    "Grant Automation permission for Messages when prompted.",
    "List chats with: imsg chats --limit 20",
    `Docs: ${formatDocsLink("/imessage", "imessage")}`,
  ],
  title: "iMessage next steps",
};

export const imessageSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  buildPatch: (input) => buildIMessageSetupPatch(input),
  channelKey: channel,
});

export const imessageSetupStatusBase = {
  configuredHint: "imsg found",
  configuredLabel: "configured",
  configuredScore: 1,
  resolveConfigured: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
    resolveIMessageAccount({ accountId, cfg }).configured,
  unconfiguredHint: "imsg missing",
  unconfiguredLabel: "needs setup",
  unconfiguredScore: 0,
};

export function createIMessageSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    completionNote: imessageCompletionNote,
    credentials: [],
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
    dmPolicy: imessageDmPolicy,
    loadWizard,
    status: {
      configuredHint: imessageSetupStatusBase.configuredHint,
      configuredLabel: imessageSetupStatusBase.configuredLabel,
      configuredScore: imessageSetupStatusBase.configuredScore,
      unconfiguredHint: imessageSetupStatusBase.unconfiguredHint,
      unconfiguredLabel: imessageSetupStatusBase.unconfiguredLabel,
      unconfiguredScore: imessageSetupStatusBase.unconfiguredScore,
    },
    textInputs: [
      createIMessageCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          inputKey: "cliPath",
          loadWizard,
        }),
      ),
    ],
  });
}
