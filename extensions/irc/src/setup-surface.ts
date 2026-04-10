import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type {
  ChannelSetupDmPolicy,
  ChannelSetupWizard,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  formatDocsLink,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultIrcAccountId, resolveIrcAccount } from "./accounts.js";
import {
  isChannelTarget,
  normalizeIrcAllowEntry,
  normalizeIrcMessagingTarget,
} from "./normalize.js";
import {
  ircSetupAdapter,
  parsePort,
  setIrcAllowFrom,
  setIrcDmPolicy,
  setIrcGroupAccess,
  setIrcNickServ,
  updateIrcAccountConfig,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const channel = "irc" as const;
const USE_ENV_FLAG = "__ircUseEnv";
const TLS_FLAG = "__ircTls";

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeGroupEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const normalized = normalizeIrcMessagingTarget(trimmed) ?? trimmed;
  if (isChannelTarget(normalized)) {
    return normalized;
  }
  return `#${normalized.replace(/^#+/, "")}`;
}

const promptIrcAllowFrom = createPromptParsedAllowFromForAccount<CoreConfig>({
  applyAllowFrom: ({ cfg, allowFrom }) => setIrcAllowFrom(cfg, allowFrom),
  defaultAccountId: (cfg) => resolveDefaultIrcAccountId(cfg),
  getExistingAllowFrom: ({ cfg }) => cfg.channels?.irc?.allowFrom ?? [],
  message: "IRC allowFrom (nick or nick!user@host)",
  noteLines: [
    "Allowlist IRC DMs by sender.",
    "Examples:",
    "- alice",
    "- alice!ident@example.org",
    "Multiple entries: comma-separated.",
  ],
  noteTitle: "IRC allowlist",
  parseEntries: (raw) => ({
    entries: parseListInput(raw)
      .map((entry) => normalizeIrcAllowEntry(entry))
      .map((entry) => entry.trim())
      .filter(Boolean),
  }),
  placeholder: "alice, bob!ident@example.org",
});

async function promptIrcNickServConfig(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  const resolved = resolveIrcAccount({ accountId: params.accountId, cfg: params.cfg });
  const existing = resolved.config.nickserv;
  const hasExisting = Boolean(existing?.password || existing?.passwordFile);
  const wants = await params.prompter.confirm({
    initialValue: hasExisting,
    message: hasExisting ? "Update NickServ settings?" : "Configure NickServ identify/register?",
  });
  if (!wants) {
    return params.cfg;
  }

  const service = String(
    await params.prompter.text({
      initialValue: existing?.service || "NickServ",
      message: "NickServ service nick",
      validate: (value) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    }),
  ).trim();

  const useEnvPassword =
    params.accountId === DEFAULT_ACCOUNT_ID &&
    Boolean(process.env.IRC_NICKSERV_PASSWORD?.trim()) &&
    !(existing?.password || existing?.passwordFile)
      ? await params.prompter.confirm({
          initialValue: true,
          message: "IRC_NICKSERV_PASSWORD detected. Use env var?",
        })
      : false;

  const password = useEnvPassword
    ? undefined
    : String(
        await params.prompter.text({
          message: "NickServ password (blank to disable NickServ auth)",
          validate: () => undefined,
        }),
      ).trim();

  if (!password && !useEnvPassword) {
    return setIrcNickServ(params.cfg, params.accountId, {
      enabled: false,
      service,
    });
  }

  const register = await params.prompter.confirm({
    initialValue: existing?.register ?? false,
    message: "Send NickServ REGISTER on connect?",
  });
  const registerEmail = register
    ? String(
        await params.prompter.text({
          initialValue:
            existing?.registerEmail ||
            (params.accountId === DEFAULT_ACCOUNT_ID
              ? process.env.IRC_NICKSERV_REGISTER_EMAIL
              : undefined),
          message: "NickServ register email",
          validate: (value) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
        }),
      ).trim()
    : undefined;

  return setIrcNickServ(params.cfg, params.accountId, {
    enabled: true,
    service,
    ...(password ? { password } : {}),
    register,
    ...(registerEmail ? { registerEmail } : {}),
  });
}

const ircDmPolicy: ChannelSetupDmPolicy = {
  allowFromKey: "channels.irc.allowFrom",
  channel,
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.irc?.dmPolicy ?? "pairing",
  label: "IRC",
  policyKey: "channels.irc.dmPolicy",
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    await promptIrcAllowFrom({
      accountId,
      cfg: cfg as CoreConfig,
      prompter,
    }),
  setPolicy: (cfg, policy) => setIrcDmPolicy(cfg as CoreConfig, policy),
};

export const ircSetupWizard: ChannelSetupWizard = {
  allowFrom: createAllowFromSection({
    apply: async ({ cfg, allowFrom }) => setIrcAllowFrom(cfg as CoreConfig, allowFrom),
    helpLines: [
      "Allowlist IRC DMs by sender.",
      "Examples:",
      "- alice",
      "- alice!ident@example.org",
      "Multiple entries: comma-separated.",
    ],
    helpTitle: "IRC allowlist",
    invalidWithoutCredentialNote: "Use an IRC nick or nick!user@host entry.",
    message: "IRC allowFrom (nick or nick!user@host)",
    parseId: (raw) => {
      const normalized = normalizeIrcAllowEntry(raw);
      return normalized || null;
    },
    placeholder: "alice, bob!ident@example.org",
  }),
  channel,
  completionNote: {
    lines: [
      "Next: restart gateway and verify status.",
      "Command: openclaw channels status --probe",
      `Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`,
    ],
    title: "IRC next steps",
  },
  credentials: [],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  dmPolicy: ircDmPolicy,
  finalize: async ({ cfg, accountId, prompter }) => {
    let next = cfg as CoreConfig;

    const resolvedAfterGroups = resolveIrcAccount({ accountId, cfg: next });
    if (resolvedAfterGroups.config.groupPolicy === "allowlist") {
      const groupKeys = Object.keys(resolvedAfterGroups.config.groups ?? {});
      if (groupKeys.length > 0) {
        const wantsMentions = await prompter.confirm({
          initialValue: true,
          message: "Require @mention to reply in IRC channels?",
        });
        if (!wantsMentions) {
          const groups = resolvedAfterGroups.config.groups ?? {};
          const patched = Object.fromEntries(
            Object.entries(groups).map(([key, value]) => [
              key,
              { ...value, requireMention: false },
            ]),
          );
          next = updateIrcAccountConfig(next, accountId, { groups: patched });
        }
      }
    }

    next = await promptIrcNickServConfig({
      accountId,
      cfg: next,
      prompter,
    });
    return { cfg: next };
  },
  groupAccess: {
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setIrcGroupAccess(
        cfg as CoreConfig,
        accountId,
        "allowlist",
        resolved as string[],
        normalizeGroupEntry,
      ),
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveIrcAccount({ accountId, cfg: cfg as CoreConfig }).config.groups ?? {}),
    currentPolicy: ({ cfg, accountId }) =>
      resolveIrcAccount({ accountId, cfg: cfg as CoreConfig }).config.groupPolicy ?? "allowlist",
    label: "IRC channels",
    placeholder: "#openclaw, #ops, *",
    resolveAllowlist: async ({ entries }) =>
      [...new Set(entries.map((entry) => normalizeGroupEntry(entry)).filter(Boolean))] as string[],
    setPolicy: ({ cfg, accountId, policy }) =>
      setIrcGroupAccess(cfg as CoreConfig, accountId, policy, [], normalizeGroupEntry),
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveIrcAccount({ accountId, cfg: cfg as CoreConfig }).config.groups),
  },
  introNote: {
    lines: [
      "IRC needs server host + bot nick.",
      "Recommended: TLS on port 6697.",
      "Optional: NickServ identify/register can be configured after the basic account fields.",
      'Set channels.irc.groupPolicy="allowlist" and channels.irc.groups for tighter channel control.',
      'Note: IRC channels are mention-gated by default. To allow unmentioned replies, set channels.irc.groups["#channel"].requireMention=false (or "*" for all).',
      "Env vars supported: IRC_HOST, IRC_PORT, IRC_TLS, IRC_NICK, IRC_USERNAME, IRC_REALNAME, IRC_PASSWORD, IRC_CHANNELS, IRC_NICKSERV_PASSWORD, IRC_NICKSERV_REGISTER_EMAIL.",
      `Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`,
    ],
    shouldShow: ({ cfg, accountId }) =>
      !resolveIrcAccount({ accountId, cfg: cfg as CoreConfig }).configured,
    title: "IRC setup",
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const resolved = resolveIrcAccount({ accountId, cfg: cfg as CoreConfig });
    const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
    const envHost = isDefaultAccount ? (normalizeOptionalString(process.env.IRC_HOST) ?? "") : "";
    const envNick = isDefaultAccount ? (normalizeOptionalString(process.env.IRC_NICK) ?? "") : "";
    const envReady = Boolean(envHost && envNick && !resolved.config.host && !resolved.config.nick);

    if (envReady) {
      const useEnv = await prompter.confirm({
        initialValue: true,
        message: "IRC_HOST and IRC_NICK detected. Use env vars?",
      });
      if (useEnv) {
        return {
          cfg: updateIrcAccountConfig(cfg as CoreConfig, accountId, { enabled: true }),
          credentialValues: {
            ...credentialValues,
            [USE_ENV_FLAG]: "1",
          },
        };
      }
    }

    const tls = await prompter.confirm({
      initialValue: resolved.config.tls ?? true,
      message: "Use TLS for IRC?",
    });
    return {
      cfg: updateIrcAccountConfig(cfg as CoreConfig, accountId, {
        enabled: true,
        tls,
      }),
      credentialValues: {
        ...credentialValues,
        [USE_ENV_FLAG]: "0",
        [TLS_FLAG]: tls ? "1" : "0",
      },
    };
  },
  status: createStandardChannelSetupStatus({
    channelLabel: "IRC",
    configuredHint: "configured",
    configuredLabel: "configured",
    configuredScore: 1,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).configured,
    unconfiguredHint: "needs host + nick",
    unconfiguredLabel: "needs host + nick",
    unconfiguredScore: 0,
  }),
  textInputs: [
    {
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          host: value,
        }),
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.host || undefined,
      inputKey: "httpHost",
      message: "IRC server host",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    },
    {
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          port: parsePort(String(value), 6697),
        }),
      currentValue: ({ cfg, accountId }) =>
        String(resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.port ?? ""),
      initialValue: ({ cfg, accountId, credentialValues }) => {
        const resolved = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
        const tls = credentialValues[TLS_FLAG] !== "0";
        const defaultPort = resolved.config.port ?? (tls ? 6697 : 6667);
        return String(defaultPort);
      },
      inputKey: "httpPort",
      message: "IRC server port",
      normalizeValue: ({ value }) => String(parsePort(String(value), 6697)),
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => {
        const parsed = Number.parseInt(normalizeStringifiedOptionalString(value) ?? "", 10);
        return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535
          ? undefined
          : "Use a port between 1 and 65535";
      },
    },
    {
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          nick: value,
        }),
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.nick || undefined,
      inputKey: "token",
      message: "IRC nick",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    },
    {
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          username: value,
        }),
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.username || undefined,
      initialValue: ({ cfg, accountId, credentialValues }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.username ||
        credentialValues.token ||
        "openclaw",
      inputKey: "userId",
      message: "IRC username",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    },
    {
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          realname: value,
        }),
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.realname || undefined,
      initialValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.realname || "OpenClaw",
      inputKey: "deviceName",
      message: "IRC real name",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    },
    {
      applyEmptyValue: true,
      applySet: async ({ cfg, accountId, value }) => {
        const channels = parseListInput(String(value))
          .map((entry) => normalizeGroupEntry(entry))
          .filter((entry): entry is string => Boolean(entry && entry !== "*"))
          .filter((entry) => isChannelTarget(entry));
        return updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          channels: channels.length > 0 ? channels : undefined,
        });
      },
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.channels?.join(", "),
      inputKey: "groupChannels",
      message: "Auto-join IRC channels (optional, comma-separated)",
      normalizeValue: ({ value }) =>
        parseListInput(String(value))
          .map((entry) => normalizeGroupEntry(entry))
          .filter((entry): entry is string => Boolean(entry && entry !== "*"))
          .filter((entry) => isChannelTarget(entry))
          .join(", "),
      placeholder: "#openclaw, #ops",
      required: false,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
    },
  ],
};

export { ircSetupAdapter };
