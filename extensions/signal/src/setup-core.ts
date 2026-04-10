import {
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type ChannelSetupWizardTextInput,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  type WizardPrompter,
  createCliPathTextInput,
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  mergeAllowFromEntries,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeE164,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultSignalAccountId, resolveSignalAccount } from "./accounts.js";

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    if (normalizeLowercaseStringOrEmpty(entry).startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
}) {
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
  };
}

export async function promptSignalAllowFrom(params: {
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
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ accountId, cfg }).config.allowFrom ?? [],
    message: "Signal allowFrom (E.164 or uuid)",
    noteLines: [
      "Allowlist Signal DMs by sender id.",
      "Examples:",
      "- +15555550123",
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    noteTitle: "Signal allowlist",
    parseEntries: parseSignalAllowFromEntries,
    placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
    prompter: params.prompter,
  });
}

export const signalDmPolicy = {
  allowFromKey: "channels.signal.allowFrom",
  channel,
  getCurrent: (cfg: OpenClawConfig, accountId?: string) =>
    resolveSignalAccount({ accountId: accountId ?? resolveDefaultSignalAccountId(cfg), cfg }).config
      .dmPolicy ?? "pairing",
  label: "Signal",
  policyKey: "channels.signal.dmPolicy",
  promptAllowFrom: promptSignalAllowFrom,
  resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) =>
    (accountId ?? resolveDefaultSignalAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          allowFromKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.allowFrom`,
          policyKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.dmPolicy`,
        }
      : {
          allowFromKey: "channels.signal.allowFrom",
          policyKey: "channels.signal.dmPolicy",
        },
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) =>
    patchChannelConfigForAccount({
      accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
      cfg,
      channel,
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveSignalAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    }),
};

function resolveSignalCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  return (
    (typeof params.credentialValues.cliPath === "string"
      ? params.credentialValues.cliPath
      : undefined) ??
    resolveSignalAccount({ accountId: params.accountId, cfg: params.cfg }).config.cliPath ??
    "signal-cli"
  );
}

export function createSignalCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return createCliPathTextInput({
    helpLines: [
      "signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath.",
    ],
    helpTitle: "Signal",
    inputKey: "cliPath",
    message: "signal-cli path",
    resolvePath: ({ cfg, accountId, credentialValues }) =>
      resolveSignalCliPath({ accountId, cfg, credentialValues }),
    shouldPrompt,
  });
}

export const signalNumberTextInput: ChannelSetupWizardTextInput = {
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalAccountInput(resolveSignalAccount({ accountId, cfg }).config.account) ??
    undefined,
  inputKey: "signalNumber",
  keepPrompt: (value) => `Signal account set (${value}). Keep it?`,
  message: "Signal bot number (E.164)",
  normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
  validate: ({ value }) =>
    normalizeSignalAccountInput(value) ? undefined : INVALID_SIGNAL_ACCOUNT_ERROR,
};

export const signalCompletionNote = {
  lines: [
    'Link device with: signal-cli link -n "OpenClaw"',
    "Scan QR in Signal -> Linked Devices",
    `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
    `Docs: ${formatDocsLink("/signal", "signal")}`,
  ],
  title: "Signal next steps",
};

export const signalSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  buildPatch: (input) => buildSignalSetupPatch(input),
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    validate: ({ input }) => {
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
  }),
});

export function createSignalSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    completionNote: signalCompletionNote,
    credentials: [],
    delegatePrepare: true,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
    dmPolicy: signalDmPolicy,
    loadWizard,
    status: {
      configuredHint: "signal-cli found",
      configuredLabel: "configured",
      configuredScore: 1,
      unconfiguredHint: "signal-cli missing",
      unconfiguredLabel: "needs setup",
      unconfiguredScore: 0,
    },
    textInputs: [
      createSignalCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          inputKey: "cliPath",
          loadWizard,
        }),
      ),
      signalNumberTextInput,
    ],
  });
}
