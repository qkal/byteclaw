import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { describe, expect, it, vi } from "vitest";
import { createNonExitingTypedRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import {
  type WizardPrompter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
} from "./accounts.js";
import { feishuSetupAdapter } from "./setup-core.js";
import { feishuSetupWizard } from "./setup-surface.js";

vi.mock("./probe.js", () => ({
  probeFeishu: vi.fn(async () => ({ error: "mocked", ok: false })),
}));

const baseStatusContext = {
  accountOverrides: {},
};

const feishuSetupPlugin = {
  capabilities: {
    chatTypes: ["direct", "group"] as ("direct" | "group")[],
  },
  config: {
    defaultAccountId: (cfg: unknown) => resolveDefaultFeishuAccountId(cfg as never),
    listAccountIds: (cfg: unknown) => listFeishuAccountIds(cfg as never),
    resolveAccount: adaptScopedAccountAccessor(resolveFeishuAccount),
  },
  id: "feishu",
  meta: {
    blurb: "飞书/Lark enterprise messaging.",
    docsPath: "/channels/feishu",
    id: "feishu",
    label: "Feishu",
    selectionLabel: "Feishu/Lark (飞书)",
  },
  setup: feishuSetupAdapter,
  setupWizard: feishuSetupWizard,
} as const;

async function withEnvVars(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, prior] of previous.entries()) {
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

async function getStatusWithEnvRefs(params: { appIdKey: string; appSecretKey: string }) {
  return await feishuGetStatus({
    cfg: {
      channels: {
        feishu: {
          appId: { id: params.appIdKey, provider: "default", source: "env" },
          appSecret: { id: params.appSecretKey, provider: "default", source: "env" },
        },
      },
    } as never,
    ...baseStatusContext,
  });
}

const feishuConfigure = createPluginSetupWizardConfigure(feishuSetupPlugin);
const feishuGetStatus = createPluginSetupWizardStatus(feishuSetupPlugin);
type FeishuConfigureRuntime = Parameters<typeof feishuConfigure>[0]["runtime"];

describe("feishu setup wizard", () => {
  it("setup adapter preserves a selected named account id", () => {
    expect(
      feishuSetupPlugin.setup?.resolveAccountId?.({
        accountId: "work",
        cfg: {} as never,
        input: {},
      } as never),
    ).toBe("work");
  });

  it("setup adapter uses configured defaultAccount when accountId is omitted", () => {
    expect(
      feishuSetupPlugin.setup?.resolveAccountId?.({
        accountId: undefined,
        cfg: {
          channels: {
            feishu: {
              accounts: {
                work: {
                  appId: "work-app",
                  appSecret: "work-secret", // pragma: allowlist secret
                },
              },
              defaultAccount: "work",
            },
          },
        } as never,
        input: {},
      } as never),
    ).toBe("work");
  });

  it("does not throw when config appId/appSecret are SecretRef objects", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_prompt")
      .mockResolvedValueOnce("secret_from_prompt")
      .mockResolvedValueOnce("oc_group_1");
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async () => true),
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "allowlist",
      ) as never,
      text,
    });

    await expect(
      runSetupWizardConfigure({
        cfg: {
          channels: {
            feishu: {
              appId: { id: "FEISHU_APP_ID", provider: "default", source: "env" },
              appSecret: { id: "FEISHU_APP_SECRET", provider: "default", source: "env" },
            },
          },
        } as never,
        configure: feishuConfigure,
        prompter,
        runtime: createNonExitingTypedRuntimeEnv<FeishuConfigureRuntime>(),
      }),
    ).resolves.toBeTruthy();
  });

  it("writes selected-account credentials instead of overwriting the channel root", async () => {
    const prompter = createTestWizardPrompter({
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "websocket",
      ) as never,
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Feishu App Secret") {
          return "work-secret"; // Pragma: allowlist secret
        }
        if (message === "Enter Feishu App ID") {
          return "work-app";
        }
        if (message === "Group chat allowlist (chat_ids)") {
          return "";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      accountOverrides: {
        feishu: "work",
      },
      cfg: {
        channels: {
          feishu: {
            appId: "top-level-app",
            appSecret: "top-level-secret", // Pragma: allowlist secret
            accounts: {
              work: {
                appId: "",
              },
            },
          },
        },
      } as never,
      configure: feishuConfigure,
      prompter,
      runtime: createNonExitingTypedRuntimeEnv<FeishuConfigureRuntime>(),
    });

    expect(result.cfg.channels?.feishu?.appId).toBe("top-level-app");
    expect(result.cfg.channels?.feishu?.appSecret).toBe("top-level-secret");
    expect(result.cfg.channels?.feishu?.accounts?.work).toMatchObject({
      appId: "work-app",
      appSecret: "work-secret",
      enabled: true,
    });
  });

  it("uses configured defaultAccount for omitted finalize writes", async () => {
    const prompter = createTestWizardPrompter({
      note: vi.fn(async () => {}),
      select: vi.fn(
        async ({ message, initialValue }: { message: string; initialValue?: string }) => {
          if (message === "Feishu connection mode") {
            return initialValue ?? "websocket";
          }
          if (message === "Which Feishu domain?") {
            return initialValue ?? "feishu";
          }
          if (message === "Group chat policy") {
            return "disabled";
          }
          return initialValue ?? "websocket";
        },
      ) as never,
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Feishu App Secret") {
          return "work-secret"; // Pragma: allowlist secret
        }
        if (message === "Enter Feishu App ID") {
          return "work-app";
        }
        if (message === "Feishu webhook path") {
          return "/feishu/events";
        }
        if (message === "Group chat allowlist (chat_ids)") {
          return "";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const {setupWizard} = feishuSetupPlugin;
    if (!setupWizard || !("finalize" in setupWizard) || !setupWizard.finalize) {
      throw new Error("feishu setupWizard.finalize unavailable");
    }

    const result = await setupWizard.finalize({
      accountId: "work",
      cfg: {
        channels: {
          feishu: {
            appId: "top-level-app",
            appSecret: "top-level-secret", // Pragma: allowlist secret
            defaultAccount: "work",
            accounts: {
              work: {
                appId: "",
              },
            },
          },
        },
      } as never,
      credentialValues: {},
      forceAllowFrom: false,
      options: {},
      prompter,
      runtime: createNonExitingTypedRuntimeEnv<FeishuConfigureRuntime>(),
    });

    expect(result && typeof result === "object" && "cfg" in result).toBe(true);
    const nextCfg =
      result && typeof result === "object" && "cfg" in result ? result.cfg : undefined;
    expect(nextCfg?.channels?.feishu).toBeDefined();
    expect(nextCfg?.channels?.feishu?.appId).toBe("top-level-app");
    expect(nextCfg?.channels?.feishu?.appSecret).toBe("top-level-secret");
    expect(nextCfg?.channels?.feishu?.accounts?.work).toMatchObject({
      appId: "work-app",
      appSecret: "work-secret",
      enabled: true,
    });
  });
});

describe("feishu setup wizard status", () => {
  it("treats SecretRef appSecret as configured when appId is present", async () => {
    const status = await feishuGetStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          feishu: {
            appId: "cli_a123456",
            appSecret: {
              id: "FEISHU_APP_SECRET",
              provider: "default",
              source: "env",
            },
          },
        },
      } as never,
    });

    expect(status.configured).toBe(true);
  });

  it("does not fallback to top-level appId when account explicitly sets empty appId", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: {
                appId: "",
                appSecret: "sample-app-credential", // Pragma: allowlist secret
              },
            },
            appId: "top_level_app",
          },
        },
      } as never,
      ...baseStatusContext,
    });

    expect(status.configured).toBe(false);
  });

  it("setup status honors the selected named account", async () => {
    const status = await feishuGetStatus({
      accountOverrides: {
        feishu: "work",
      },
      cfg: {
        channels: {
          feishu: {
            appId: "top_level_app",
            appSecret: "top-level-secret", // Pragma: allowlist secret
            accounts: {
              work: {
                appId: "",
                appSecret: "work-secret", // Pragma: allowlist secret
              },
            },
          },
        },
      } as never,
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["Feishu: needs app credentials"]);
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const status = await feishuGetStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          feishu: {
            defaultAccount: "work",
            appId: "top_level_app",
            appSecret: "top-level-secret", // Pragma: allowlist secret
            accounts: {
              alerts: {
                appId: "alerts-app",
                appSecret: "alerts-secret", // Pragma: allowlist secret
              },
              work: {
                appId: "",
                appSecret: "work-secret", // Pragma: allowlist secret
              },
            },
          },
        },
      } as never,
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["Feishu: needs app credentials"]);
  });

  it("uses configured defaultAccount for omitted DM policy account context", async () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            work: {
              appId: "work-app",
              appSecret: "work-secret", // Pragma: allowlist secret
              dmPolicy: "allowlist",
              allowFrom: ["ou_work"],
            },
          },
          allowFrom: ["ou_root"],
          defaultAccount: "work",
        },
      },
    } as const;

    expect(feishuSetupWizard.dmPolicy?.getCurrent?.(cfg as never)).toBe("allowlist");
    expect(feishuSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg as never)).toEqual({
      allowFromKey: "channels.feishu.accounts.work.allowFrom",
      policyKey: "channels.feishu.accounts.work.dmPolicy",
    });

    const next = feishuSetupWizard.dmPolicy?.setPolicy?.(cfg as never, "open");
    const workAccount = next?.channels?.feishu?.accounts?.work as
      | {
          dmPolicy?: string;
          allowFrom?: string[];
        }
      | undefined;

    expect(next?.channels?.feishu?.dmPolicy).toBeUndefined();
    expect(next?.channels?.feishu?.allowFrom).toEqual(["ou_root"]);
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["ou_work", "*"]);
  });

  it("treats env SecretRef appId as not configured when env var is missing", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_MISSING_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_MISSING_TEST"; // Pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: undefined,
        [appSecretKey]: "env-credential-456", // Pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(false);
      },
    );
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_TEST"; // Pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: "cli_env_123",
        [appSecretKey]: "env-credential-456", // Pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(true);
      },
    );
  });
});
