import { describe, expect, it, vi } from "vitest";
import { matrixOnboardingAdapter } from "./onboarding.js";
import {
  createMatrixWizardPrompter,
  installMatrixOnboardingEnvRestoreHooks,
  runMatrixAddAccountAllowlistConfigure,
  runMatrixInteractiveConfigure,
} from "./onboarding.test-harness.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

vi.mock("./matrix/deps.js", () => ({
  ensureMatrixSdkInstalled: vi.fn(async () => {}),
  isMatrixSdkAvailable: vi.fn(() => true),
}));

describe("matrix onboarding", () => {
  installMatrixOnboardingEnvRestoreHooks();

  it("offers env shortcut for non-default account when scoped env vars are present", async () => {
    installMatrixTestRuntime();

    process.env.MATRIX_HOMESERVER = "https://matrix.env.example.org";
    process.env.MATRIX_USER_ID = "@env:example.org";
    process.env.MATRIX_PASSWORD = "env-password"; // Pragma: allowlist secret
    process.env.MATRIX_ACCESS_TOKEN = "";
    process.env.MATRIX_OPS_HOMESERVER = "https://matrix.ops.env.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";

    const confirmMessages: string[] = [];
    const prompter = createMatrixWizardPrompter({
      onConfirm: (message) => {
        confirmMessages.push(message);
        return message.startsWith("Matrix env vars detected");
      },
      select: {
        "Matrix already configured. What do you want to do?": "add-account",
        "Matrix auth method": "token",
      },
      text: {
        "Matrix account name": "ops",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                accessToken: "main-token",
                homeserver: "https://matrix.main.example.org",
              },
            },
          },
        },
      } as CoreConfig,
      configured: true,
      prompter,
      shouldPromptAccountIds: true,
    });

    expect(result).not.toBe("skip");
    if (result !== "skip") {
      const opsAccount = result.cfg.channels?.["matrix"]?.accounts?.ops as
        | {
            enabled?: boolean;
            homeserver?: string;
            accessToken?: string;
          }
        | undefined;
      expect(result.accountId).toBe("ops");
      expect(opsAccount).toMatchObject({
        enabled: true,
      });
      expect(opsAccount?.homeserver).toBeUndefined();
      expect(opsAccount?.accessToken).toBeUndefined();
    }
    expect(
      confirmMessages.some((message) =>
        message.startsWith(
          "Matrix env vars detected (MATRIX_OPS_HOMESERVER (+ auth vars)). Use env values?",
        ),
      ),
    ).toBe(true);
  });

  it("routes env-shortcut add-account flow through Matrix invite auto-join setup", async () => {
    installMatrixTestRuntime();

    process.env.MATRIX_HOMESERVER = "https://matrix.env.example.org";
    process.env.MATRIX_USER_ID = "@env:example.org";
    process.env.MATRIX_PASSWORD = "env-password"; // Pragma: allowlist secret
    process.env.MATRIX_ACCESS_TOKEN = "";
    process.env.MATRIX_OPS_HOMESERVER = "https://matrix.ops.env.example.org";
    process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";

    const notes: string[] = [];
    const prompter = createMatrixWizardPrompter({
      confirm: {
        "Configure Matrix invite auto-join?": true,
        "Configure Matrix rooms access?": true,
      },
      notes,
      onConfirm: (message) => message.startsWith("Matrix env vars detected"),
      select: {
        "Matrix already configured. What do you want to do?": "add-account",
        "Matrix invite auto-join": "allowlist",
        "Matrix rooms access": "allowlist",
      },
      text: {
        "Matrix account name": "ops",
        "Matrix invite auto-join allowlist (comma-separated)": "#ops-invites:example.org",
        "Matrix rooms allowlist (comma-separated)": "!ops-room:example.org",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                accessToken: "main-token",
                homeserver: "https://matrix.main.example.org",
              },
            },
          },
        },
      } as CoreConfig,
      configured: true,
      prompter,
      shouldPromptAccountIds: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.accountId).toBe("ops");
    expect(result.cfg.channels?.matrix?.accounts?.ops).toMatchObject({
      autoJoin: "allowlist",
      autoJoinAllowlist: ["#ops-invites:example.org"],
      enabled: true,
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { enabled: true },
      },
    });
    expect(notes.join("\n")).toContain("WARNING: Matrix invite auto-join defaults to off.");
  });

  it("promotes legacy top-level Matrix config before adding a named account", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixWizardPrompter({
      onConfirm: async () => false,
      select: {
        "Matrix already configured. What do you want to do?": "add-account",
        "Matrix auth method": "token",
      },
      text: {
        "Matrix access token": "ops-token",
        "Matrix account name": "ops",
        "Matrix device name (optional)": "",
        "Matrix homeserver URL": "https://matrix.ops.example.org",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accessToken: "main-token",
            avatarUrl: "mxc://matrix.main.example.org/main-avatar",
            homeserver: "https://matrix.main.example.org",
            userId: "@main:example.org",
          },
        },
      } as CoreConfig,
      configured: true,
      prompter,
      shouldPromptAccountIds: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.homeserver).toBeUndefined();
    expect(result.cfg.channels?.matrix?.accessToken).toBeUndefined();
    expect(result.cfg.channels?.matrix?.avatarUrl).toBeUndefined();
    expect(result.cfg.channels?.matrix?.accounts?.default).toMatchObject({
      accessToken: "main-token",
      avatarUrl: "mxc://matrix.main.example.org/main-avatar",
      homeserver: "https://matrix.main.example.org",
      userId: "@main:example.org",
    });
    expect(result.cfg.channels?.matrix?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      homeserver: "https://matrix.ops.example.org",
      name: "ops",
    });
  });

  it("reuses an existing raw default-like key during onboarding promotion when defaultAccount is unset", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixWizardPrompter({
      onConfirm: async () => false,
      select: {
        "Matrix already configured. What do you want to do?": "add-account",
        "Matrix auth method": "token",
      },
      text: {
        "Matrix access token": "ops-token",
        "Matrix account name": "ops",
        "Matrix device name (optional)": "",
        "Matrix homeserver URL": "https://matrix.ops.example.org",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accessToken: "main-token",
            accounts: {
              Default: {
                deviceName: "Legacy raw key",
                enabled: true,
              },
              support: {
                accessToken: "support-token",
                homeserver: "https://matrix.support.example.org",
              },
            },
            avatarUrl: "mxc://matrix.main.example.org/main-avatar",
            homeserver: "https://matrix.main.example.org",
            userId: "@main:example.org",
          },
        },
      } as CoreConfig,
      configured: true,
      prompter,
      shouldPromptAccountIds: true,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.accounts?.Default).toMatchObject({
      accessToken: "main-token",
      avatarUrl: "mxc://matrix.main.example.org/main-avatar",
      deviceName: "Legacy raw key",
      enabled: true,
      homeserver: "https://matrix.main.example.org",
      userId: "@main:example.org",
    });
    expect(result.cfg.channels?.matrix?.accounts?.default).toBeUndefined();
    expect(result.cfg.channels?.matrix?.accounts?.support).toMatchObject({
      accessToken: "support-token",
      homeserver: "https://matrix.support.example.org",
    });
    expect(result.cfg.channels?.matrix?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      homeserver: "https://matrix.ops.example.org",
      name: "ops",
    });
  });

  it("includes device env var names in auth help text", async () => {
    installMatrixTestRuntime();

    const notes: string[] = [];
    const prompter = createMatrixWizardPrompter({
      notes,
      onConfirm: async () => false,
      onSelect: async () => "token",
      onText: async () => {
        throw new Error("stop-after-help");
      },
    });

    await expect(
      runMatrixInteractiveConfigure({
        cfg: { channels: {} } as CoreConfig,
        prompter,
      }),
    ).rejects.toThrow("stop-after-help");

    const noteText = notes.join("\n");
    expect(noteText).toContain("MATRIX_DEVICE_ID");
    expect(noteText).toContain("MATRIX_DEVICE_NAME");
    expect(noteText).toContain("MATRIX_<ACCOUNT_ID>_DEVICE_ID");
    expect(noteText).toContain("MATRIX_<ACCOUNT_ID>_DEVICE_NAME");
  });

  it("prompts for private-network access when onboarding an internal http homeserver", async () => {
    installMatrixTestRuntime();

    const prompter = createMatrixWizardPrompter({
      confirm: {
        "Allow private/internal Matrix homeserver traffic for this account?": true,
        "Enable end-to-end encryption (E2EE)?": false,
      },
      onConfirm: async () => false,
      select: {
        "Matrix auth method": "token",
      },
      text: {
        "Matrix access token": "ops-token",
        "Matrix device name (optional)": "",
        "Matrix homeserver URL": "http://localhost.localdomain:8008",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {} as CoreConfig,
      prompter,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix).toMatchObject({
      accessToken: "ops-token",
      homeserver: "http://localhost.localdomain:8008",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  it("preserves SecretRef access tokens when keeping existing credentials", async () => {
    installMatrixTestRuntime();

    process.env.MATRIX_ACCESS_TOKEN = "env-token";

    const prompter = createMatrixWizardPrompter({
      confirm: {
        "Configure Matrix invite auto-join?": false,
        "Configure Matrix rooms access?": false,
        "Enable end-to-end encryption (E2EE)?": false,
        "Matrix credentials already configured. Keep them?": true,
      },
      select: {
        "Matrix already configured. What do you want to do?": "update",
      },
      text: {
        "Matrix device name (optional)": "OpenClaw Gateway",
        "Matrix homeserver URL": "https://matrix.example.org",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accessToken: { id: "MATRIX_ACCESS_TOKEN", provider: "default", source: "env" },
            homeserver: "https://matrix.example.org",
          },
        },
        secrets: {
          defaults: {
            env: "default",
          },
        },
      } as CoreConfig,
      configured: true,
      prompter,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.accessToken).toEqual({
      id: "MATRIX_ACCESS_TOKEN",
      provider: "default",
      source: "env",
    });
  });

  it("resolves status using the overridden Matrix account", async () => {
    const status = await matrixOnboardingAdapter.getStatus({
      accountOverrides: {
        matrix: "ops",
      },
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                homeserver: "https://matrix.default.example.org",
              },
              ops: {
                accessToken: "ops-token",
                homeserver: "https://matrix.ops.example.org",
              },
            },
            defaultAccount: "default",
          },
        },
      } as CoreConfig,
      options: undefined,
    });

    expect(status.configured).toBe(true);
    expect(status.selectionHint).toBe("configured");
    expect(status.statusLines).toEqual(["Matrix: configured"]);
  });

  it("writes allowlists and room access to the selected Matrix account", async () => {
    installMatrixTestRuntime();
    const notes: string[] = [];

    const result = await runMatrixAddAccountAllowlistConfigure({
      allowFromInput: "@alice:example.org",
      autoJoinAllowlistInput: "#ops-invites:example.org",
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                accessToken: "main-token",
                homeserver: "https://matrix.main.example.org",
              },
            },
          },
        },
      } as CoreConfig,
      deviceName: "Ops Gateway",
      notes,
      roomsAllowlistInput: "!ops-room:example.org",
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.accountId).toBe("ops");
    expect(result.cfg.channels?.["matrix"]?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      autoJoin: "allowlist",
      autoJoinAllowlist: ["#ops-invites:example.org"],
      deviceName: "Ops Gateway",
      dm: {
        allowFrom: ["@alice:example.org"],
        policy: "allowlist",
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { enabled: true },
      },
      homeserver: "https://matrix.ops.example.org",
    });
    expect(result.cfg.channels?.["matrix"]?.dm).toBeUndefined();
    expect(result.cfg.channels?.["matrix"]?.groups).toBeUndefined();
    expect(notes.join("\n")).toContain("WARNING: Matrix invite auto-join defaults to off.");
  });

  it("clears Matrix invite auto-join allowlists when switching auto-join off", async () => {
    installMatrixTestRuntime();
    const notes: string[] = [];

    const prompter = createMatrixWizardPrompter({
      confirm: {
        "Configure Matrix invite auto-join?": true,
        "Configure Matrix rooms access?": false,
        "Enable end-to-end encryption (E2EE)?": false,
        "Matrix credentials already configured. Keep them?": true,
        "Update Matrix invite auto-join?": true,
      },
      notes,
      select: {
        "Matrix already configured. What do you want to do?": "update",
        "Matrix invite auto-join": "off",
      },
      text: {
        "Matrix device name (optional)": "OpenClaw Gateway",
        "Matrix homeserver URL": "https://matrix.example.org",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accessToken: "matrix-token",
            autoJoin: "allowlist",
            autoJoinAllowlist: ["#ops:example.org"],
            homeserver: "https://matrix.example.org",
          },
        },
      } as CoreConfig,
      configured: true,
      prompter,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(result.cfg.channels?.matrix?.autoJoin).toBe("off");
    expect(result.cfg.channels?.matrix?.autoJoinAllowlist).toBeUndefined();
    expect(notes.join("\n")).toContain("Matrix invite auto-join remains off.");
    expect(notes.join("\n")).toContain(
      "Agents will not join invited rooms or fresh DM-style invites until you change autoJoin.",
    );
  });

  it("re-prompts Matrix invite auto-join allowlists until entries are stable invite targets", async () => {
    installMatrixTestRuntime();
    const notes: string[] = [];
    let inviteAllowlistPrompts = 0;

    const prompter = createMatrixWizardPrompter({
      confirm: {
        "Configure Matrix invite auto-join?": true,
        "Configure Matrix rooms access?": false,
        "Enable end-to-end encryption (E2EE)?": false,
        "Matrix credentials already configured. Keep them?": true,
        "Update Matrix invite auto-join?": true,
      },
      notes,
      onText: async (message) => {
        if (message === "Matrix invite auto-join allowlist (comma-separated)") {
          inviteAllowlistPrompts += 1;
          return inviteAllowlistPrompts === 1 ? "Project Room" : "#ops:example.org";
        }
        throw new Error(`unexpected text prompt: ${message}`);
      },
      select: {
        "Matrix already configured. What do you want to do?": "update",
        "Matrix invite auto-join": "allowlist",
      },
      text: {
        "Matrix device name (optional)": "OpenClaw Gateway",
        "Matrix homeserver URL": "https://matrix.example.org",
      },
    });

    const result = await runMatrixInteractiveConfigure({
      cfg: {
        channels: {
          matrix: {
            accessToken: "matrix-token",
            homeserver: "https://matrix.example.org",
          },
        },
      } as CoreConfig,
      configured: true,
      prompter,
    });

    expect(result).not.toBe("skip");
    if (result === "skip") {
      return;
    }

    expect(inviteAllowlistPrompts).toBe(2);
    expect(result.cfg.channels?.matrix?.autoJoin).toBe("allowlist");
    expect(result.cfg.channels?.matrix?.autoJoinAllowlist).toEqual(["#ops:example.org"]);
    expect(notes.join("\n")).toContain(
      "Use only stable Matrix invite targets for auto-join: !roomId:server, #alias:server, or *.",
    );
    expect(notes.join("\n")).toContain("Invalid: Project Room");
  });

  it("reports account-scoped DM config keys for named accounts", () => {
    const resolveConfigKeys = matrixOnboardingAdapter.dmPolicy?.resolveConfigKeys;
    expect(resolveConfigKeys).toBeDefined();
    if (!resolveConfigKeys) {
      return;
    }

    expect(
      resolveConfigKeys(
        {
          channels: {
            matrix: {
              accounts: {
                default: {
                  homeserver: "https://matrix.main.example.org",
                },
                ops: {
                  homeserver: "https://matrix.ops.example.org",
                },
              },
            },
          },
        } as CoreConfig,
        "ops",
      ),
    ).toEqual({
      allowFromKey: "channels.matrix.accounts.ops.dm.allowFrom",
      policyKey: "channels.matrix.accounts.ops.dm.policy",
    });
  });

  it("reports configured when only the effective default Matrix account is configured", async () => {
    installMatrixTestRuntime();

    const status = await matrixOnboardingAdapter.getStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {
                accessToken: "ops-token",
                homeserver: "https://matrix.ops.example.org",
              },
            },
            defaultAccount: "ops",
          },
        },
      } as CoreConfig,
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toContain("Matrix: configured");
    expect(status.selectionHint).toBe("configured");
  });

  it("asks for defaultAccount when multiple named Matrix accounts exist", async () => {
    installMatrixTestRuntime();

    const status = await matrixOnboardingAdapter.getStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          matrix: {
            accounts: {
              assistant: {
                accessToken: "assistant-token",
                homeserver: "https://matrix.assistant.example.org",
              },
              ops: {
                accessToken: "ops-token",
                homeserver: "https://matrix.ops.example.org",
              },
            },
          },
        },
      } as CoreConfig,
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual([
      'Matrix: set "channels.matrix.defaultAccount" to select a named account',
    ]);
    expect(status.selectionHint).toBe("set defaultAccount");
  });
});
