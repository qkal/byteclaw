import {
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  type SecretInput,
  buildSingleChannelSecretPromptState,
  createStandardChannelSetupStatus,
  hasConfiguredSecretInput,
  promptSingleChannelSecretInput,
  runSingleChannelSecretStep,
} from "openclaw/plugin-sdk/setup";
import { resolveZaloAccount } from "./accounts.js";
import { noteZaloTokenHelp, promptZaloAllowFrom } from "./setup-allow-from.js";
import { zaloDmPolicy } from "./setup-core.js";

const channel = "zalo" as const;

type UpdateMode = "polling" | "webhook";

function setZaloUpdateMode(
  cfg: OpenClawConfig,
  accountId: string,
  mode: UpdateMode,
  webhookUrl?: string,
  webhookSecret?: SecretInput,
  webhookPath?: string,
): OpenClawConfig {
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  if (mode === "polling") {
    if (isDefault) {
      const {
        webhookUrl: _url,
        webhookSecret: _secret,
        webhookPath: _path,
        ...rest
      } = cfg.channels?.zalo ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zalo: rest,
        },
      } as OpenClawConfig;
    }
    const accounts = { ...cfg.channels?.zalo?.accounts } as Record<string, Record<string, unknown>>;
    const existing = accounts[accountId] ?? {};
    const { webhookUrl: _url, webhookSecret: _secret, webhookPath: _path, ...rest } = existing;
    accounts[accountId] = rest;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          accounts,
        },
      },
    } as OpenClawConfig;
  }

  if (isDefault) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          webhookPath,
          webhookSecret,
          webhookUrl,
        },
      },
    } as OpenClawConfig;
  }

  const accounts = { ...cfg.channels?.zalo?.accounts } as Record<string, Record<string, unknown>>;
  accounts[accountId] = {
    ...accounts[accountId],
    webhookPath,
    webhookSecret,
    webhookUrl,
  };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        accounts,
      },
    },
  } as OpenClawConfig;
}

export { zaloSetupAdapter } from "./setup-core.js";

export const zaloSetupWizard: ChannelSetupWizard = {
  channel,
  credentials: [],
  dmPolicy: zaloDmPolicy,
  finalize: async ({ cfg, accountId, forceAllowFrom, options, prompter }) => {
    let next = cfg;
    const resolvedAccount = resolveZaloAccount({
      accountId,
      allowUnresolvedSecretRef: true,
      cfg: next,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const hasConfigToken = Boolean(
      hasConfiguredSecretInput(resolvedAccount.config.botToken) || resolvedAccount.config.tokenFile,
    );
    const tokenStep = await runSingleChannelSecretStep({
      accountConfigured,
      allowEnv,
      applySet: async (currentCfg, value) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? ({
              ...currentCfg,
              channels: {
                ...currentCfg.channels,
                zalo: {
                  ...currentCfg.channels?.zalo,
                  enabled: true,
                  botToken: value,
                },
              },
            } as OpenClawConfig)
          : ({
              ...currentCfg,
              channels: {
                ...currentCfg.channels,
                zalo: {
                  ...currentCfg.channels?.zalo,
                  enabled: true,
                  accounts: {
                    ...currentCfg.channels?.zalo?.accounts,
                    [accountId]: {
                      ...(currentCfg.channels?.zalo?.accounts?.[accountId] as
                        | Record<string, unknown>
                        | undefined),
                      enabled: true,
                      botToken: value,
                    },
                  },
                },
              },
            } as OpenClawConfig),
      applyUseEnv: async (currentCfg) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? ({
              ...currentCfg,
              channels: {
                ...currentCfg.channels,
                zalo: {
                  ...currentCfg.channels?.zalo,
                  enabled: true,
                },
              },
            } as OpenClawConfig)
          : currentCfg,
      cfg: next,
      credentialLabel: "bot token",
      envPrompt: "ZALO_BOT_TOKEN detected. Use env var?",
      envValue: process.env.ZALO_BOT_TOKEN,
      hasConfigToken,
      inputPrompt: "Enter Zalo bot token",
      keepPrompt: "Zalo token already configured. Keep it?",
      onMissingConfigured: async () => await noteZaloTokenHelp(prompter),
      preferredEnvVar: "ZALO_BOT_TOKEN",
      prompter,
      providerHint: "zalo",
      secretInputMode: options?.secretInputMode,
    });
    next = tokenStep.cfg;

    const wantsWebhook = await prompter.confirm({
      initialValue: Boolean(resolvedAccount.config.webhookUrl),
      message: "Use webhook mode for Zalo?",
    });
    if (wantsWebhook) {
      const webhookUrl = String(
        await prompter.text({
          initialValue: resolvedAccount.config.webhookUrl,
          message: "Webhook URL (https://...) ",
          validate: (value) =>
            value?.trim()?.startsWith("https://") ? undefined : "HTTPS URL required",
        }),
      ).trim();
      const defaultPath = (() => {
        try {
          return new URL(webhookUrl).pathname || "/zalo-webhook";
        } catch {
          return "/zalo-webhook";
        }
      })();

      let webhookSecretResult = await promptSingleChannelSecretInput({
        cfg: next,
        prompter,
        providerHint: "zalo-webhook",
        credentialLabel: "webhook secret",
        secretInputMode: options?.secretInputMode,
        ...buildSingleChannelSecretPromptState({
          accountConfigured: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
          allowEnv: false,
          hasConfigToken: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
        }),
        envPrompt: "",
        keepPrompt: "Zalo webhook secret already configured. Keep it?",
        inputPrompt: "Webhook secret (8-256 chars)",
        preferredEnvVar: "ZALO_WEBHOOK_SECRET",
      });
      while (
        webhookSecretResult.action === "set" &&
        typeof webhookSecretResult.value === "string" &&
        (webhookSecretResult.value.length < 8 || webhookSecretResult.value.length > 256)
      ) {
        await prompter.note("Webhook secret must be between 8 and 256 characters.", "Zalo webhook");
        webhookSecretResult = await promptSingleChannelSecretInput({
          cfg: next,
          prompter,
          providerHint: "zalo-webhook",
          credentialLabel: "webhook secret",
          secretInputMode: options?.secretInputMode,
          ...buildSingleChannelSecretPromptState({
            accountConfigured: false,
            allowEnv: false,
            hasConfigToken: false,
          }),
          envPrompt: "",
          keepPrompt: "Zalo webhook secret already configured. Keep it?",
          inputPrompt: "Webhook secret (8-256 chars)",
          preferredEnvVar: "ZALO_WEBHOOK_SECRET",
        });
      }
      const webhookSecret =
        webhookSecretResult.action === "set"
          ? webhookSecretResult.value
          : resolvedAccount.config.webhookSecret;
      const webhookPath = String(
        await prompter.text({
          initialValue: resolvedAccount.config.webhookPath ?? defaultPath,
          message: "Webhook path (optional)",
        }),
      ).trim();
      next = setZaloUpdateMode(
        next,
        accountId,
        "webhook",
        webhookUrl,
        webhookSecret,
        webhookPath || undefined,
      );
    } else {
      next = setZaloUpdateMode(next, accountId, "polling");
    }

    if (forceAllowFrom) {
      next = await promptZaloAllowFrom({
        accountId,
        cfg: next,
        prompter,
      });
    }

    return { cfg: next };
  },
  status: createStandardChannelSetupStatus({
    channelLabel: "Zalo",
    configuredHint: "recommended · configured",
    configuredLabel: "configured",
    configuredScore: 1,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) => {
      const account = resolveZaloAccount({
        cfg,
        accountId,
        allowUnresolvedSecretRef: true,
      });
      return (
        Boolean(account.token) ||
        hasConfiguredSecretInput(account.config.botToken) ||
        Boolean(account.config.tokenFile?.trim())
      );
    },
    unconfiguredHint: "recommended · newcomer-friendly",
    unconfiguredLabel: "needs token",
    unconfiguredScore: 10,
  }),
};
