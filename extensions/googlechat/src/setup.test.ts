import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type WizardPrompter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import {
  expectLifecyclePatch,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/plugins/start-account-lifecycle.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { type ResolvedGoogleChatAccount, resolveGoogleChatAccount } from "./accounts.js";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
} from "./channel.deps.runtime.js";
import { startGoogleChatGatewayAccount } from "./gateway.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

const hoisted = vi.hoisted(() => ({
  startGoogleChatMonitor: vi.fn(),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    startGoogleChatMonitor: hoisted.startGoogleChatMonitor,
  };
});

const googlechatSetupPlugin = {
  config: {
    defaultAccountId: resolveDefaultGoogleChatAccountId,
    listAccountIds: listGoogleChatAccountIds,
  },
  id: "googlechat",
  meta: {
    label: "Google Chat",
  },
  setupWizard: googlechatSetupWizard,
} as never;

const googlechatConfigure = createPluginSetupWizardConfigure(googlechatSetupPlugin);
const googlechatStatus = createPluginSetupWizardStatus(googlechatSetupPlugin);

function buildAccount(): ResolvedGoogleChatAccount {
  return {
    accountId: "default",
    config: {
      audience: "https://example.com/googlechat",
      audienceType: "app-url",
      webhookPath: "/googlechat",
      webhookUrl: "https://example.com/googlechat",
    },
    credentialSource: "inline",
    credentials: {},
    enabled: true,
  };
}

describe("googlechat setup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects env auth for non-default accounts", () => {
    if (!googlechatSetupAdapter.validateInput) {
      throw new Error("Expected googlechatSetupAdapter.validateInput to be defined");
    }
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.");
  });

  it("requires inline or file credentials when env auth is not used", () => {
    if (!googlechatSetupAdapter.validateInput) {
      throw new Error("Expected googlechatSetupAdapter.validateInput to be defined");
    }
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { token: "", tokenFile: "", useEnv: false },
      } as never),
    ).toBe("Google Chat requires --token (service account JSON) or --token-file.");
  });

  it("builds a patch from token-file and trims optional webhook fields", () => {
    if (!googlechatSetupAdapter.applyAccountConfig) {
      throw new Error("Expected googlechatSetupAdapter.applyAccountConfig to be defined");
    }
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: { channels: { googlechat: {} } },
        input: {
          audience: " https://example.com/googlechat ",
          audienceType: " app-url ",
          name: "Default",
          tokenFile: "/tmp/googlechat.json",
          webhookPath: " /googlechat ",
          webhookUrl: " https://example.com/googlechat/hook ",
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          audience: "https://example.com/googlechat",
          audienceType: "app-url",
          enabled: true,
          name: "Default",
          serviceAccountFile: "/tmp/googlechat.json",
          webhookPath: "/googlechat",
          webhookUrl: "https://example.com/googlechat/hook",
        },
      },
    });
  });

  it("prefers inline token patch when token-file is absent", () => {
    if (!googlechatSetupAdapter.applyAccountConfig) {
      throw new Error("Expected googlechatSetupAdapter.applyAccountConfig to be defined");
    }
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: { channels: { googlechat: {} } },
        input: {
          name: "Default",
          token: { client_email: "bot@example.com" },
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          enabled: true,
          name: "Default",
          serviceAccount: { client_email: "bot@example.com" },
        },
      },
    });
  });

  it("configures service-account auth and webhook audience", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Service account JSON path") {
          return "/tmp/googlechat-service-account.json";
        }
        if (message === "App URL") {
          return "https://example.com/googlechat";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      cfg: {} as OpenClawConfig,
      configure: googlechatConfigure,
      options: {},
      prompter,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.googlechat?.enabled).toBe(true);
    expect(result.cfg.channels?.googlechat?.serviceAccountFile).toBe(
      "/tmp/googlechat-service-account.json",
    );
    expect(result.cfg.channels?.googlechat?.audienceType).toBe("app-url");
    expect(result.cfg.channels?.googlechat?.audience).toBe("https://example.com/googlechat");
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      googlechatSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            googlechat: {
              accounts: {
                alerts: {
                  dm: {
                    policy: "allowlist",
                  },
                  serviceAccount: { client_email: "bot@example.com" },
                },
              },
              dm: {
                policy: "disabled",
              },
            },
          },
        } as OpenClawConfig,
        "alerts",
      ),
    ).toBe("allowlist");
  });

  it("reports configured state for the selected account instead of any account", async () => {
    const status = await googlechatStatus({
      accountOverrides: {
        googlechat: "alerts",
      },
      cfg: {
        channels: {
          googlechat: {
            accounts: {
              alerts: {},
              default: {
                serviceAccount: { client_email: "default@example.com" },
              },
            },
          },
        },
      } as OpenClawConfig,
      options: {},
    });

    expect(status.configured).toBe(false);
  });

  it("reports configured state for the configured defaultAccount instead of any account", async () => {
    const status = await googlechatStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          googlechat: {
            accounts: {
              alerts: {},
              default: {
                serviceAccount: { client_email: "default@example.com" },
              },
            },
            defaultAccount: "alerts",
          },
        },
      } as OpenClawConfig,
      options: {},
    });

    expect(status.configured).toBe(false);
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(googlechatSetupWizard.dmPolicy?.resolveConfigKeys?.({}, "alerts")).toEqual({
      allowFromKey: "channels.googlechat.accounts.alerts.dm.allowFrom",
      policyKey: "channels.googlechat.accounts.alerts.dm.policy",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg = {
      channels: {
        googlechat: {
          accounts: {
            alerts: {
              dm: {
                policy: "allowlist",
              },
              serviceAccount: { client_email: "bot@example.com" },
            },
          },
          defaultAccount: "alerts",
          dm: {
            policy: "disabled",
          },
        },
      },
    } as OpenClawConfig;

    expect(googlechatSetupWizard.dmPolicy?.getCurrent(cfg)).toBe("allowlist");
    expect(googlechatSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg)).toEqual({
      allowFromKey: "channels.googlechat.accounts.alerts.dm.allowFrom",
      policyKey: "channels.googlechat.accounts.alerts.dm.policy",
    });

    const next = googlechatSetupWizard.dmPolicy?.setPolicy(cfg, "open");
    expect(next?.channels?.googlechat?.dm?.policy).toBe("disabled");
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.policy).toBe("open");
  });

  it("uses configured defaultAccount for omitted allowFrom prompt context", async () => {
    const prompter = {
      note: vi.fn(async () => {}),
      text: vi.fn(async () => "users/123456789"),
    };

    const next = await googlechatSetupWizard.dmPolicy?.promptAllowFrom?.({
      cfg: {
        channels: {
          googlechat: {
            accounts: {
              alerts: {
                dm: {
                  allowFrom: ["users/alerts"],
                },
                serviceAccount: { client_email: "bot@example.com" },
              },
            },
            defaultAccount: "alerts",
            dm: {
              allowFrom: ["users/root"],
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompter as any,
    });

    expect(next?.channels?.googlechat?.dm?.allowFrom).toEqual(["users/root"]);
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.allowFrom).toEqual([
      "users/123456789",
    ]);
  });

  it('writes open DM policy to the named account and preserves inherited allowFrom with "*"', () => {
    const next = googlechatSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          googlechat: {
            accounts: {
              alerts: {
                serviceAccount: { client_email: "bot@example.com" },
              },
            },
            dm: {
              allowFrom: ["users/123"],
            },
          },
        },
      } as OpenClawConfig,
      "open",
      "alerts",
    );

    expect(next?.channels?.googlechat?.dm?.policy).toBeUndefined();
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.policy).toBe("open");
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.allowFrom).toEqual(["users/123", "*"]);
  });

  it("keeps startAccount pending until abort, then unregisters", async () => {
    const unregister = vi.fn();
    hoisted.startGoogleChatMonitor.mockResolvedValue(unregister);

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      account: buildAccount(),
      startAccount: startGoogleChatGatewayAccount,
    });
    await expectPendingUntilAbort({
      abort,
      assertAfterAbort: () => {
        expect(unregister).toHaveBeenCalledOnce();
      },
      assertBeforeAbort: () => {
        expect(unregister).not.toHaveBeenCalled();
      },
      isSettled,
      task,
      waitForStarted: waitForStartedMocks(hoisted.startGoogleChatMonitor),
    });
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });
});

describe("resolveGoogleChatAccount", () => {
  it("parses default-account env JSON credentials only when they decode to an object", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '{"client_email":"bot@example.com"}');

    const resolved = resolveGoogleChatAccount({
      accountId: "default",
      cfg: { channels: { googlechat: {} } },
    });

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toEqual({ client_email: "bot@example.com" });
  });

  it("ignores env JSON credentials when they decode to a non-object value", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '["not","an","object"]');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "/tmp/googlechat.json");

    const resolved = resolveGoogleChatAccount({
      accountId: "default",
      cfg: { channels: { googlechat: {} } },
    });

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toBeUndefined();
    expect(resolved.credentialsFile).toBe("/tmp/googlechat.json");
  });

  it("inherits shared defaults from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
            default: {
              audience: "https://example.com/googlechat",
              audienceType: "app-url",
              webhookPath: "/googlechat",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ accountId: "andy", cfg });
    expect(resolved.config.audienceType).toBe("app-url");
    expect(resolved.config.audience).toBe("https://example.com/googlechat");
    expect(resolved.config.webhookPath).toBe("/googlechat");
    expect(resolved.config.serviceAccountFile).toBe("/tmp/andy-sa.json");
  });

  it("prefers top-level and account overrides over accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            april: {
              webhookPath: "/googlechat-april",
            },
            default: {
              audience: "https://default.example.com/googlechat",
              audienceType: "app-url",
              webhookPath: "/googlechat-default",
            },
          },
          audience: "1234567890",
          audienceType: "project-number",
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ accountId: "april", cfg });
    expect(resolved.config.audienceType).toBe("project-number");
    expect(resolved.config.audience).toBe("1234567890");
    expect(resolved.config.webhookPath).toBe("/googlechat-april");
  });

  it("does not inherit disabled state from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
            default: {
              audience: "https://example.com/googlechat",
              audienceType: "app-url",
              enabled: false,
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ accountId: "andy", cfg });
    expect(resolved.enabled).toBe(true);
    expect(resolved.config.enabled).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit default-account credentials into named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
            default: {
              audience: "https://example.com/googlechat",
              audienceType: "app-url",
              serviceAccountRef: {
                id: "default-sa",
                provider: "test",
                source: "env",
              },
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ accountId: "andy", cfg });
    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/tmp/andy-sa.json");
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit dangerous name matching from accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
            default: {
              audience: "https://example.com/googlechat",
              audienceType: "app-url",
              dangerouslyAllowNameMatching: true,
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ accountId: "andy", cfg });
    expect(resolved.config.dangerouslyAllowNameMatching).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            alerts: {
              serviceAccountFile: "/tmp/alerts-sa.json",
            },
          },
          defaultAccount: "alerts",
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg });
    expect(resolved.accountId).toBe("alerts");
    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/tmp/alerts-sa.json");
  });
});
