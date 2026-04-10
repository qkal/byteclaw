import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type WizardPrompter,
  createTestWizardPrompter,
  runSetupWizardFinalize,
} from "../../../test/helpers/plugins/setup-wizard.js";
import { createSlackSetupWizardBase } from "./setup-core.js";

const slackSetupWizard = createSlackSetupWizardBase({
  promptAllowFrom: async ({ cfg }) => cfg,
  resolveAllowFromEntries: async ({ entries }) =>
    entries.map((entry) => ({
      id: null,
      input: entry,
      resolved: false,
    })),
  resolveGroupAllowlist: async ({ entries }) => entries,
});

describe("slackSetupWizard.finalize", () => {
  const baseCfg = {
    channels: {
      slack: {
        appToken: "xapp-test",
        botToken: "xoxb-test",
      },
    },
  } as OpenClawConfig;

  it("prompts to enable interactive replies for newly configured Slack accounts", async () => {
    const confirm = vi.fn(async () => true);

    const result = await runSetupWizardFinalize({
      cfg: baseCfg,
      finalize: slackSetupWizard.finalize,
      prompter: createTestWizardPrompter({
        confirm: confirm as WizardPrompter["confirm"],
      }),
    });
    if (!result?.cfg) {
      throw new Error("expected finalize to patch config");
    }

    expect(confirm).toHaveBeenCalledWith({
      initialValue: true,
      message: "Enable Slack interactive replies (buttons/selects) for agent responses?",
    });
    expect(
      (result.cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } })
        ?.capabilities?.interactiveReplies,
    ).toBe(true);
  });

  it("auto-enables interactive replies for quickstart defaults without prompting", async () => {
    const confirm = vi.fn(async () => false);

    const result = await runSetupWizardFinalize({
      cfg: baseCfg,
      finalize: slackSetupWizard.finalize,
      options: { quickstartDefaults: true },
      prompter: createTestWizardPrompter({
        confirm: confirm as WizardPrompter["confirm"],
      }),
    });
    if (!result?.cfg) {
      throw new Error("expected finalize to patch config");
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(
      (result.cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } })
        ?.capabilities?.interactiveReplies,
    ).toBe(true);
  });
});

describe("slackSetupWizard.dmPolicy", () => {
  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      slackSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            slack: {
              accounts: {
                alerts: {
                  appToken: "xapp-alerts",
                  botToken: "xoxb-alerts",
                  dmPolicy: "allowlist",
                },
              },
              dmPolicy: "disabled",
            },
          },
        } as OpenClawConfig,
        "alerts",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(slackSetupWizard.dmPolicy?.resolveConfigKeys?.({}, "alerts")).toEqual({
      allowFromKey: "channels.slack.accounts.alerts.allowFrom",
      policyKey: "channels.slack.accounts.alerts.dmPolicy",
    });
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = slackSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          slack: {
            accounts: {
              alerts: {
                appToken: "xapp-alerts",
                botToken: "xoxb-alerts",
              },
            },
            allowFrom: ["U123"],
          },
        },
      } as OpenClawConfig,
      "open",
      "alerts",
    );

    expect(next?.channels?.slack?.dmPolicy).toBeUndefined();
    expect(next?.channels?.slack?.accounts?.alerts?.dmPolicy).toBe("open");
    expect(next?.channels?.slack?.accounts?.alerts?.allowFrom).toEqual(["U123", "*"]);
  });
});

describe("slackSetupWizard.status", () => {
  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await slackSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          slack: {
            accounts: {
              alerts: {
                appToken: "xapp-alerts",
                botToken: "xoxb-alerts",
              },
              work: {
                appToken: "",
                botToken: "",
              },
            },
            appToken: "xapp-root",
            botToken: "xoxb-root",
            defaultAccount: "work",
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });
});
