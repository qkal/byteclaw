import { describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import "./zalo-js.test-mocks.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { zalouserSetupPlugin } from "./setup-test-helpers.js";

const zalouserConfigure = createPluginSetupWizardConfigure(zalouserSetupPlugin);

async function runSetup(params: {
  cfg?: OpenClawConfig;
  prompter: ReturnType<typeof createTestWizardPrompter>;
  options?: Record<string, unknown>;
  forceAllowFrom?: boolean;
}) {
  return await runSetupWizardConfigure({
    cfg: params.cfg,
    configure: zalouserConfigure,
    forceAllowFrom: params.forceAllowFrom,
    options: params.options,
    prompter: params.prompter,
  });
}

describe("zalouser setup wizard", () => {
  function createQuickstartPrompter(params?: {
    note?: ReturnType<typeof createTestWizardPrompter>["note"];
    seen?: string[];
    dmPolicy?: "pairing" | "allowlist";
    groupAccess?: boolean;
    groupPolicy?: "allowlist";
    textByMessage?: Record<string, string>;
  }) {
    const select = vi.fn(
      async ({ message, options }: { message: string; options: { value: string }[] }) => {
        const first = options[0];
        if (!first) {
          throw new Error("no options");
        }
        params?.seen?.push(message);
        if (message === "Zalo Personal DM policy" && params?.dmPolicy) {
          return params.dmPolicy;
        }
        if (message === "Zalo groups access" && params?.groupPolicy) {
          return params.groupPolicy;
        }
        return first.value;
      },
    ) as ReturnType<typeof createTestWizardPrompter>["select"];
    const text = vi.fn(
      async ({ message }: { message: string }) => params?.textByMessage?.[message] ?? "",
    ) as ReturnType<typeof createTestWizardPrompter>["text"];
    return createTestWizardPrompter({
      ...(params?.note ? { note: params.note } : {}),
      confirm: vi.fn(async ({ message }: { message: string }) => {
        params?.seen?.push(message);
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return params?.groupAccess ?? false;
        }
        return false;
      }),
      select,
      text,
    });
  }

  it("enables the account without forcing QR login", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
    });

    const result = await runSetup({ prompter });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
  });

  it("prompts DM policy before group access in quickstart", async () => {
    const seen: string[] = [];
    const prompter = createQuickstartPrompter({ dmPolicy: "pairing", seen });

    const result = await runSetup({
      options: { quickstartDefaults: true },
      prompter,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.channels?.zalouser?.dmPolicy).toBe("pairing");
    expect(seen.indexOf("Zalo Personal DM policy")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("Configure Zalo groups access?")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("Zalo Personal DM policy")).toBeLessThan(
      seen.indexOf("Configure Zalo groups access?"),
    );
  });

  it("allows an empty quickstart DM allowlist with a warning", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({
      dmPolicy: "allowlist",
      note,
      textByMessage: {
        "Zalouser allowFrom (name or user id)": "",
      },
    });

    const result = await runSetup({
      options: { quickstartDefaults: true },
      prompter,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.channels?.zalouser?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.allowFrom).toEqual([]);
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No DM allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("allows an empty group allowlist with a warning", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({
      groupAccess: true,
      groupPolicy: "allowlist",
      note,
      textByMessage: {
        "Zalo groups allowlist (comma-separated)": "",
      },
    });

    const result = await runSetup({ prompter });

    expect(result.cfg.channels?.zalouser?.groupPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.groups).toEqual({});
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No group allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("writes canonical enabled entries for configured groups", async () => {
    const prompter = createQuickstartPrompter({
      groupAccess: true,
      groupPolicy: "allowlist",
      textByMessage: {
        "Zalo groups allowlist (comma-separated)": "Family, Work",
      },
    });

    const result = await runSetup({ prompter });

    expect(result.cfg.channels?.zalouser?.groups).toEqual({
      Family: { enabled: true, requireMention: true },
      Work: { enabled: true, requireMention: true },
    });
  });

  it("preserves non-quickstart forceAllowFrom behavior", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const seen: string[] = [];
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        seen.push(message);
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
      note,
      text: vi.fn(async ({ message }: { message: string }) => {
        seen.push(message);
        if (message === "Zalouser allowFrom (name or user id)") {
          return "";
        }
        return "";
      }) as ReturnType<typeof createTestWizardPrompter>["text"],
    });

    const result = await runSetup({ forceAllowFrom: true, prompter });

    expect(result.cfg.channels?.zalouser?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.allowFrom).toEqual([]);
    expect(seen).not.toContain("Zalo Personal DM policy");
    expect(seen).toContain("Zalouser allowFrom (name or user id)");
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No DM allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("allowlists the plugin when a plugin allowlist already exists", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
    });

    const result = await runSetup({
      cfg: {
        plugins: {
          allow: ["telegram"],
        },
      } as OpenClawConfig,
      prompter,
    });

    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["telegram", "zalouser"]);
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      zalouserSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            zalouser: {
              accounts: {
                work: {
                  dmPolicy: "allowlist",
                  profile: "work",
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
    expect(zalouserSetupWizard.dmPolicy?.resolveConfigKeys?.({} as OpenClawConfig, "work")).toEqual(
      {
        allowFromKey: "channels.zalouser.accounts.work.allowFrom",
        policyKey: "channels.zalouser.accounts.work.dmPolicy",
      },
    );
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg = {
      channels: {
        zalouser: {
          accounts: {
            work: {
              dmPolicy: "allowlist",
              profile: "work-profile",
            },
          },
          allowFrom: ["123456789"],
          defaultAccount: "work",
          dmPolicy: "disabled",
        },
      },
    } as OpenClawConfig;

    expect(zalouserSetupWizard.dmPolicy?.getCurrent(cfg)).toBe("allowlist");
    expect(zalouserSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg)).toEqual({
      allowFromKey: "channels.zalouser.accounts.work.allowFrom",
      policyKey: "channels.zalouser.accounts.work.dmPolicy",
    });

    const next = zalouserSetupWizard.dmPolicy?.setPolicy(cfg, "open");
    expect(next?.channels?.zalouser?.dmPolicy).toBe("disabled");
    const workAccount = next?.channels?.zalouser?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: (string | number)[] }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = zalouserSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          zalouser: {
            accounts: {
              work: {
                profile: "work",
              },
            },
            allowFrom: ["123456789"],
          },
        },
      } as OpenClawConfig,
      "open",
      "work",
    );

    expect(next?.channels?.zalouser?.dmPolicy).toBeUndefined();
    const workAccount = next?.channels?.zalouser?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: (string | number)[] }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["123456789", "*"]);
  });

  it("shows the account-scoped current DM policy in quickstart notes", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({ dmPolicy: "pairing", note });

    await runSetupWizardConfigure({
      accountOverrides: { zalouser: "work" },
      cfg: {
        channels: {
          zalouser: {
            accounts: {
              work: {
                allowFrom: ["123456789"],
                dmPolicy: "allowlist",
                profile: "work",
              },
            },
            dmPolicy: "disabled",
          },
        },
      } as OpenClawConfig,
      configure: zalouserConfigure,
      options: { quickstartDefaults: true },
      prompter,
    });

    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("Current: dmPolicy=allowlist, allowFrom=123456789"),
      ),
    ).toBe(true);
  });
});
