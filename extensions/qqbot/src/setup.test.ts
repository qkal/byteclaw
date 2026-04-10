import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/plugins/setup-wizard.js";
import { qqbotConfigAdapter, qqbotMeta, qqbotSetupAdapterShared } from "./channel-config-shared.js";
import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { qqbotSetupWizard } from "./setup-surface.js";

const qqbotSetupPlugin = {
  config: {
    ...qqbotConfigAdapter,
  },
  id: "qqbot",
  meta: {
    ...qqbotMeta,
  },
  setup: {
    ...qqbotSetupAdapterShared,
  },
  setupWizard: qqbotSetupWizard,
};

const getQQBotSetupStatus = createPluginSetupWizardStatus(qqbotSetupPlugin as never);

describe("qqbot setup", () => {
  it("treats SecretRef-backed default accounts as configured", () => {
    const configured = qqbotSetupWizard.status.resolveConfigured?.({
      cfg: {
        channels: {
          qqbot: {
            appId: "123456",
            clientSecret: {
              id: "QQBOT_CLIENT_SECRET",
              provider: "default",
              source: "env",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(true);
  });

  it("treats named accounts with clientSecretFile as configured", () => {
    const configured = qqbotSetupWizard.status.resolveConfigured?.({
      cfg: {
        channels: {
          qqbot: {
            accounts: {
              bot2: {
                appId: "654321",
                clientSecretFile: "/tmp/qqbot-secret.txt",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(true);
  });

  it("setup status honors the selected named account", async () => {
    const status = await getQQBotSetupStatus({
      accountOverrides: {
        qqbot: "bot2",
      },
      cfg: {
        channels: {
          qqbot: {
            accounts: {
              bot2: {
                appId: "654321",
              },
            },
            appId: "123456",
            clientSecret: {
              id: "QQBOT_CLIENT_SECRET",
              provider: "default",
              source: "env",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["QQ Bot: needs AppID + AppSecret"]);
  });

  it("marks unresolved SecretRef accounts as configured in setup-only plugin status", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: {
            id: "QQBOT_CLIENT_SECRET",
            provider: "default",
            source: "env",
          },
        },
      },
    } as OpenClawConfig;

    const account = qqbotSetupPlugin.config.resolveAccount?.(cfg, DEFAULT_ACCOUNT_ID);

    expect(account?.clientSecret).toBe("");
    expect(qqbotSetupPlugin.config.isConfigured?.(account)).toBe(true);
    expect(qqbotSetupPlugin.config.describeAccount?.(account)?.configured).toBe(true);
  });

  it("keeps the sibling credential when switching only AppSecret to env mode", async () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: "secret-from-config",
        },
      },
    } as OpenClawConfig;

    const next = await qqbotSetupWizard.credentials[1].applyUseEnv!({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg,
    });

    expect(next.channels?.qqbot).toMatchObject({
      appId: "123456",
    });
    expect("clientSecret" in (next.channels?.qqbot ?? {})).toBe(false);
    expect("clientSecretFile" in (next.channels?.qqbot ?? {})).toBe(false);
  });

  it("normalizes account ids to lowercase", () => {
    const {setup} = qqbotSetupPlugin;
    expect(setup).toBeDefined();

    expect(
      setup.resolveAccountId?.({
        accountId: " Bot2 ",
      } as never),
    ).toBe("bot2");
  });

  it("uses configured defaultAccount when setup accountId is omitted", () => {
    const {setup} = qqbotSetupPlugin;
    expect(setup).toBeDefined();

    expect(
      setup.resolveAccountId?.({
        accountId: undefined,
        cfg: {
          channels: {
            qqbot: {
              accounts: {
                bot2: { appId: "123456" },
              },
              defaultAccount: "bot2",
            },
          },
        } as OpenClawConfig,
      } as never),
    ).toBe("bot2");
  });
});
