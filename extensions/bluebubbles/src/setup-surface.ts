import {
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  formatDocsLink,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveBlueBubblesAccount, resolveDefaultBlueBubblesAccountId } from "./accounts.js";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import {
  blueBubblesSetupAdapter,
  setBlueBubblesAllowFrom,
  setBlueBubblesDmPolicy,
} from "./setup-core.js";
import { parseBlueBubblesAllowTarget } from "./targets.js";
import { normalizeBlueBubblesServerUrl } from "./types.js";
import { DEFAULT_WEBHOOK_PATH } from "./webhook-shared.js";

const channel = "bluebubbles" as const;
const CONFIGURE_CUSTOM_WEBHOOK_FLAG = "__bluebubblesConfigureCustomWebhookPath";

function parseBlueBubblesAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateBlueBubblesAllowFromEntry(value: string): string | null {
  try {
    if (value === "*") {
      return value;
    }
    const parsed = parseBlueBubblesAllowTarget(value);
    if (parsed.kind === "handle" && !parsed.handle) {
      return null;
    }
    return normalizeOptionalString(value) ?? null;
  } catch {
    return null;
  }
}

const promptBlueBubblesAllowFrom = createPromptParsedAllowFromForAccount({
  applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
    setBlueBubblesAllowFrom(cfg, accountId, allowFrom),
  defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg),
  getExistingAllowFrom: ({ cfg, accountId }) =>
    resolveBlueBubblesAccount({ accountId, cfg }).config.allowFrom ?? [],
  message: "BlueBubbles allowFrom (handle or chat_id)",
  noteLines: [
    "Allowlist BlueBubbles DMs by handle or chat target.",
    "Examples:",
    "- +15555550123",
    "- user@example.com",
    "- chat_id:123",
    "- chat_guid:iMessage;-;+15555550123",
    "Multiple entries: comma- or newline-separated.",
    `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
  ],
  noteTitle: "BlueBubbles allowlist",
  parseEntries: (raw) => {
    const entries = parseBlueBubblesAllowFromInput(raw);
    for (const entry of entries) {
      if (!validateBlueBubblesAllowFromEntry(entry)) {
        return { entries: [], error: `Invalid entry: ${entry}` };
      }
    }
    return { entries };
  },
  placeholder: "+15555550123, user@example.com, chat_id:123",
});

function validateBlueBubblesServerUrlInput(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return "Required";
  }
  try {
    const normalized = normalizeBlueBubblesServerUrl(trimmed);
    new URL(normalized);
    return undefined;
  } catch {
    return "Invalid URL format";
  }
}

function applyBlueBubblesSetupPatch(
  cfg: OpenClawConfig,
  accountId: string,
  patch: {
    serverUrl?: string;
    password?: unknown;
    webhookPath?: string;
  },
): OpenClawConfig {
  return applyBlueBubblesConnectionConfig({
    accountEnabled: "preserve-or-true",
    accountId,
    cfg,
    onlyDefinedFields: true,
    patch,
  });
}

function validateBlueBubblesWebhookPath(value: string): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "Required";
  }
  if (!trimmed.startsWith("/")) {
    return "Path must start with /";
  }
  return undefined;
}

const dmPolicy: ChannelSetupDmPolicy = {
  allowFromKey: "channels.bluebubbles.allowFrom",
  channel,
  getCurrent: (cfg, accountId) =>
    resolveBlueBubblesAccount({
      accountId: accountId ?? resolveDefaultBlueBubblesAccountId(cfg),
      cfg,
    }).config.dmPolicy ?? "pairing",
  label: "BlueBubbles",
  policyKey: "channels.bluebubbles.dmPolicy",
  promptAllowFrom: promptBlueBubblesAllowFrom,
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultBlueBubblesAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          allowFromKey: `channels.bluebubbles.accounts.${accountId ?? resolveDefaultBlueBubblesAccountId(cfg)}.allowFrom`,
          policyKey: `channels.bluebubbles.accounts.${accountId ?? resolveDefaultBlueBubblesAccountId(cfg)}.dmPolicy`,
        }
      : {
          allowFromKey: "channels.bluebubbles.allowFrom",
          policyKey: "channels.bluebubbles.dmPolicy",
        },
  setPolicy: (cfg, policy, accountId) =>
    setBlueBubblesDmPolicy(cfg, accountId ?? resolveDefaultBlueBubblesAccountId(cfg), policy),
};

export const blueBubblesSetupWizard: ChannelSetupWizard = {
  allowFrom: createAllowFromSection({
    apply: async ({ cfg, accountId, allowFrom }) =>
      setBlueBubblesAllowFrom(cfg, accountId, allowFrom),
    helpLines: [
      "Allowlist BlueBubbles DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:iMessage;-;+15555550123",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ],
    helpTitle: "BlueBubbles allowlist",
    invalidWithoutCredentialNote:
      "Use a BlueBubbles handle or chat target like +15555550123 or chat_id:123.",
    message: "BlueBubbles allowFrom (handle or chat_id)",
    parseId: (raw) => validateBlueBubblesAllowFromEntry(raw),
    parseInputs: parseBlueBubblesAllowFromInput,
    placeholder: "+15555550123, user@example.com, chat_id:123",
  }),
  channel,
  completionNote: {
    lines: [
      "Configure the webhook URL in BlueBubbles Server:",
      "1. Open BlueBubbles Server -> Settings -> Webhooks",
      "2. Add your OpenClaw gateway URL + webhook path",
      `   Example: https://your-gateway-host:3000${DEFAULT_WEBHOOK_PATH}`,
      "3. Enable the webhook and save",
      "",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ],
    title: "BlueBubbles next steps",
  },
  credentials: [
    {
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          password: value,
        }),
      credentialLabel: "server password",
      envPrompt: "",
      helpLines: [
        "Enter the BlueBubbles server password.",
        "Find this in the BlueBubbles Server app under Settings.",
      ],
      helpTitle: "BlueBubbles password",
      inputKey: "password",
      inputPrompt: "BlueBubbles password",
      inspect: ({ cfg, accountId }) => {
        const existingPassword = resolveBlueBubblesAccount({ cfg, accountId }).config.password;
        return {
          accountConfigured: resolveBlueBubblesAccount({ cfg, accountId }).configured,
          hasConfiguredValue: hasConfiguredSecretInput(existingPassword),
          resolvedValue: normalizeSecretInputString(existingPassword) ?? undefined,
        };
      },
      keepPrompt: "BlueBubbles password already set. Keep it?",
      providerHint: channel,
    },
  ],
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      bluebubbles: {
        ...cfg.channels?.bluebubbles,
        enabled: false,
      },
    },
  }),
  dmPolicy,
  prepare: async ({ cfg, accountId, prompter, credentialValues }) => {
    const existingWebhookPath = normalizeOptionalString(
      resolveBlueBubblesAccount({ accountId, cfg }).config.webhookPath,
    );
    const wantsCustomWebhook = await prompter.confirm({
      initialValue: Boolean(existingWebhookPath && existingWebhookPath !== DEFAULT_WEBHOOK_PATH),
      message: `Configure a custom webhook path? (default: ${DEFAULT_WEBHOOK_PATH})`,
    });
    return {
      cfg: wantsCustomWebhook
        ? cfg
        : applyBlueBubblesSetupPatch(cfg, accountId, { webhookPath: DEFAULT_WEBHOOK_PATH }),
      credentialValues: {
        ...credentialValues,
        [CONFIGURE_CUSTOM_WEBHOOK_FLAG]: wantsCustomWebhook ? "1" : "0",
      },
    };
  },
  status: {
    ...createStandardChannelSetupStatus({
      channelLabel: "BlueBubbles",
      configuredHint: "configured",
      configuredLabel: "configured",
      configuredScore: 1,
      includeStatusLine: true,
      resolveConfigured: ({ cfg, accountId }) =>
        resolveBlueBubblesAccount({ cfg, accountId }).configured,
      unconfiguredHint: "iMessage via BlueBubbles app",
      unconfiguredLabel: "needs setup",
      unconfiguredScore: 0,
    }),
    resolveSelectionHint: ({ configured }) =>
      configured ? "configured" : "iMessage via BlueBubbles app",
  },
  stepOrder: "text-first",
  textInputs: [
    {
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          serverUrl: value,
        }),
      currentValue: ({ cfg, accountId }) =>
        normalizeOptionalString(resolveBlueBubblesAccount({ cfg, accountId }).config.serverUrl),
      helpLines: [
        "Enter the BlueBubbles server URL (e.g., http://192.168.1.100:1234).",
        "Find this in the BlueBubbles Server app under Connection.",
        `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
      ],
      helpTitle: "BlueBubbles server URL",
      inputKey: "httpUrl",
      message: "BlueBubbles server URL",
      normalizeValue: ({ value }) => String(value).trim(),
      placeholder: "http://192.168.1.100:1234",
      validate: ({ value }) => validateBlueBubblesServerUrlInput(value),
    },
    {
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          webhookPath: value,
        }),
      currentValue: ({ cfg, accountId }) => {
        const value = normalizeOptionalString(
          resolveBlueBubblesAccount({ cfg, accountId }).config.webhookPath,
        );
        return value && value !== DEFAULT_WEBHOOK_PATH ? value : undefined;
      },
      inputKey: "webhookPath",
      message: "Webhook path",
      normalizeValue: ({ value }) => String(value).trim(),
      placeholder: DEFAULT_WEBHOOK_PATH,
      shouldPrompt: ({ credentialValues }) =>
        credentialValues[CONFIGURE_CUSTOM_WEBHOOK_FLAG] === "1",
      validate: ({ value }) => validateBlueBubblesWebhookPath(value),
    },
  ],
};

export { blueBubblesSetupAdapter };
