import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  type WizardPrompter,
  createStandardChannelSetupStatus,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeSecretInputString } from "./secret-input.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

export const msteamsSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg }) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
      },
    },
  }),
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
};

const channel = "msteams" as const;

async function promptMSTeamsCredentials(prompter: WizardPrompter): Promise<{
  appId: string;
  appPassword: string;
  tenantId: string;
}> {
  const appId = String(
    await prompter.text({
      message: "Enter MS Teams App ID",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const appPassword = String(
    await prompter.text({
      message: "Enter MS Teams App Password",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const tenantId = String(
    await prompter.text({
      message: "Enter MS Teams Tenant ID",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  return { appId, appPassword, tenantId };
}

async function noteMSTeamsCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Azure Bot registration -> get App ID + Tenant ID",
      "2) Add a client secret (App Password)",
      "3) Set webhook URL + messaging endpoint",
      "Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
      `Docs: ${formatDocsLink("/channels/msteams", "msteams")}`,
    ].join("\n"),
    "MS Teams credentials",
  );
}

export function createMSTeamsSetupWizardBase(): Pick<
  ChannelSetupWizard,
  | "channel"
  | "resolveAccountIdForConfigure"
  | "resolveShouldPromptAccountIds"
  | "status"
  | "credentials"
  | "finalize"
> {
  return {
    channel,
    credentials: [],
    finalize: async ({ cfg, prompter }) => {
      const resolved = resolveMSTeamsCredentials(cfg.channels?.msteams);
      const hasConfigCreds = hasConfiguredMSTeamsCredentials(cfg.channels?.msteams);
      const canUseEnv = Boolean(
        !hasConfigCreds &&
        normalizeSecretInputString(process.env.MSTEAMS_APP_ID) &&
        normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD) &&
        normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID),
      );

      let next: OpenClawConfig = cfg;
      let appId: string | null = null;
      let appPassword: string | null = null;
      let tenantId: string | null = null;

      if (!resolved && !hasConfigCreds) {
        await noteMSTeamsCredentialHelp(prompter);
      }

      if (canUseEnv) {
        const keepEnv = await prompter.confirm({
          initialValue: true,
          message:
            "MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD + MSTEAMS_TENANT_ID detected. Use env vars?",
        });
        if (keepEnv) {
          next = msteamsSetupAdapter.applyAccountConfig({
            accountId: DEFAULT_ACCOUNT_ID,
            cfg: next,
            input: {},
          });
        } else {
          ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
        }
      } else if (hasConfigCreds) {
        const keep = await prompter.confirm({
          initialValue: true,
          message: "MS Teams credentials already configured. Keep them?",
        });
        if (!keep) {
          ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
        }
      } else {
        ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
      }

      if (appId && appPassword && tenantId) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            msteams: {
              ...next.channels?.msteams,
              appId,
              appPassword,
              enabled: true,
              tenantId,
            },
          },
        };
      }

      return { accountId: DEFAULT_ACCOUNT_ID, cfg: next };
    },
    resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
    resolveShouldPromptAccountIds: () => false,
    status: createStandardChannelSetupStatus({
      channelLabel: "MS Teams",
      configuredHint: "configured",
      configuredLabel: "configured",
      configuredScore: 2,
      includeStatusLine: true,
      resolveConfigured: ({ cfg }) =>
        Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)) ||
        hasConfiguredMSTeamsCredentials(cfg.channels?.msteams),
      unconfiguredHint: "needs app creds",
      unconfiguredLabel: "needs app credentials",
      unconfiguredScore: 0,
    }),
  };
}
