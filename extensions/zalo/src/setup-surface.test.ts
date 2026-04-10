import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { describe, expect, it, vi } from "vitest";
import {
  type WizardPrompter,
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { listZaloAccountIds, resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";
import { zaloDmPolicy } from "./setup-core.js";
import { zaloSetupAdapter, zaloSetupWizard } from "./setup-surface.js";

const zaloSetupPlugin = {
  capabilities: {
    chatTypes: ["direct", "group"] as ("direct" | "group")[],
  },
  config: {
    defaultAccountId: (cfg: unknown) => resolveDefaultZaloAccountId(cfg as never),
    listAccountIds: (cfg: unknown) => listZaloAccountIds(cfg as never),
    resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
  },
  id: "zalo",
  meta: {
    blurb: "Vietnam-focused messaging platform with Bot API.",
    docsPath: "/channels/zalo",
    id: "zalo",
    label: "Zalo",
    selectionLabel: "Zalo (Bot API)",
  },
  setup: zaloSetupAdapter,
  setupWizard: zaloSetupWizard,
} as const;

const zaloConfigure = createPluginSetupWizardConfigure(zaloSetupPlugin);

describe("zalo setup wizard", () => {
  it("configures a polling token flow", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Use webhook mode for Zalo?") {
          return false;
        }
        return false;
      }),
      select: vi.fn(async () => "plaintext") as WizardPrompter["select"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Zalo bot token") {
          return "12345689:abc-xyz";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      cfg: {} as OpenClawConfig,
      configure: zaloConfigure,
      options: { secretInputMode: "plaintext" as const },
      prompter,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalo?.enabled).toBe(true);
    expect(result.cfg.channels?.zalo?.botToken).toBe("12345689:abc-xyz");
    expect(result.cfg.channels?.zalo?.webhookUrl).toBeUndefined();
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      zaloDmPolicy.getCurrent(
        {
          channels: {
            zalo: {
              accounts: {
                work: {
                  botToken: "12345689:abc-xyz",
                  dmPolicy: "allowlist",
                },
              },
              dmPolicy: "disabled",
            },
          },
        } as OpenClawConfig,
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(zaloDmPolicy.resolveConfigKeys?.({} as OpenClawConfig, "work")).toEqual({
      allowFromKey: "channels.zalo.accounts.work.allowFrom",
      policyKey: "channels.zalo.accounts.work.dmPolicy",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg = {
      channels: {
        zalo: {
          accounts: {
            work: {
              botToken: "12345689:abc-xyz",
              dmPolicy: "allowlist",
            },
          },
          allowFrom: ["123456789"],
          defaultAccount: "work",
          dmPolicy: "disabled",
        },
      },
    } as OpenClawConfig;

    expect(zaloDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(zaloDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      allowFromKey: "channels.zalo.accounts.work.allowFrom",
      policyKey: "channels.zalo.accounts.work.dmPolicy",
    });

    const next = zaloDmPolicy.setPolicy(cfg, "open");
    expect(next.channels?.zalo?.dmPolicy).toBe("disabled");
    const workAccount = next.channels?.zalo?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: (string | number)[] }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = zaloDmPolicy.setPolicy(
      {
        channels: {
          zalo: {
            accounts: {
              work: {
                botToken: "12345689:abc-xyz",
              },
            },
            allowFrom: ["123456789"],
          },
        },
      } as OpenClawConfig,
      "open",
      "work",
    );

    expect(next.channels?.zalo?.dmPolicy).toBeUndefined();
    const workAccount = next.channels?.zalo?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: (string | number)[] }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["123456789", "*"]);
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await zaloSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          zalo: {
            accounts: {
              alerts: {
                botToken: "alerts-token",
              },
              work: {
                botToken: "",
              },
            },
            botToken: "root-token",
            defaultAccount: "work",
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });
});
