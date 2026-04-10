import { describe, expect, it, vi } from "vitest";
import {
  type WizardPrompter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../api.js";
import { TlonAuthorizationSchema, TlonConfigSchema } from "./config-schema.js";
import { tlonSetupWizard } from "./setup-surface.js";
import { normalizeShip, resolveTlonOutboundTarget } from "./targets.js";
import { listTlonAccountIds, resolveTlonAccount } from "./types.js";

const tlonTestPlugin = {
  config: {
    defaultAccountId: () => "default",
    formatAllowFrom: ({
      allowFrom,
    }: {
      cfg: OpenClawConfig;
      allowFrom: (string | number)[] | undefined | null;
    }) => (allowFrom ?? []).map((entry) => normalizeShip(String(entry))).filter(Boolean),
    listAccountIds: listTlonAccountIds,
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      resolveTlonAccount(cfg, accountId).dmAllowlist,
  },
  id: "tlon",
  meta: { label: "Tlon" },
  setup: {
    resolveAccountId: ({ accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      accountId ?? "default",
  },
  setupWizard: tlonSetupWizard,
};

const tlonConfigure = createPluginSetupWizardConfigure(tlonTestPlugin);
const tlonStatus = createPluginSetupWizardStatus(tlonTestPlugin);

describe("tlon core", () => {
  it("formats dm allowlist entries through the shared hybrid adapter", () => {
    expect(
      tlonTestPlugin.config.formatAllowFrom?.({
        allowFrom: ["zod", " ~nec "],
        cfg: {} as OpenClawConfig,
      }),
    ).toEqual(["~zod", "~nec"]);
  });

  it("returns an empty dm allowlist when the default account is unconfigured", () => {
    expect(
      tlonTestPlugin.config.resolveAllowFrom?.({
        accountId: "default",
        cfg: {} as OpenClawConfig,
      }),
    ).toEqual([]);
  });

  it("resolves dm allowlist from the default account", () => {
    expect(
      tlonTestPlugin.config.resolveAllowFrom?.({
        accountId: "default",
        cfg: {
          channels: {
            tlon: {
              code: "lidlut-tabwed-pillex-ridrup",
              dmAllowlist: ["~zod"],
              ship: "~sampel-palnet",
              url: "https://urbit.example.com",
            },
          },
        } as OpenClawConfig,
      }),
    ).toEqual(["~zod"]);
  });

  it("accepts channelRules with string keys", () => {
    const parsed = TlonAuthorizationSchema.parse({
      channelRules: {
        "chat/~zod/test": {
          allowedShips: ["~zod"],
          mode: "open",
        },
      },
    });

    expect(parsed.channelRules?.["chat/~zod/test"]?.mode).toBe("open");
  });

  it("accepts accounts with string keys", () => {
    const parsed = TlonConfigSchema.parse({
      accounts: {
        primary: {
          code: "code-123",
          ship: "~zod",
          url: "https://example.com",
        },
      },
    });

    expect(parsed.accounts?.primary?.ship).toBe("~zod");
  });

  it("configures ship, auth, and discovery settings", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Add group channels manually? (optional)") {
          return true;
        }
        if (message === "Restrict DMs with an allowlist?") {
          return true;
        }
        if (message === "Enable auto-discovery of group channels?") {
          return true;
        }
        return false;
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Ship name") {
          return "sampel-palnet";
        }
        if (message === "Ship URL") {
          return "https://urbit.example.com";
        }
        if (message === "Login code") {
          return "lidlut-tabwed-pillex-ridrup";
        }
        if (message === "Group channels (comma-separated)") {
          return "chat/~host-ship/general, chat/~host-ship/support";
        }
        if (message === "DM allowlist (comma-separated ship names)") {
          return "~zod, nec";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      cfg: {} as OpenClawConfig,
      configure: tlonConfigure,
      options: {},
      prompter,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.tlon?.enabled).toBe(true);
    expect(result.cfg.channels?.tlon?.ship).toBe("~sampel-palnet");
    expect(result.cfg.channels?.tlon?.url).toBe("https://urbit.example.com");
    expect(result.cfg.channels?.tlon?.code).toBe("lidlut-tabwed-pillex-ridrup");
    expect(result.cfg.channels?.tlon?.groupChannels).toEqual([
      "chat/~host-ship/general",
      "chat/~host-ship/support",
    ]);
    expect(result.cfg.channels?.tlon?.dmAllowlist).toEqual(["~zod", "~nec"]);
    expect(result.cfg.channels?.tlon?.autoDiscoverChannels).toBe(true);
    expect(result.cfg.channels?.tlon?.network?.dangerouslyAllowPrivateNetwork).toBe(false);
  });

  it("resolves dm targets to normalized ships", () => {
    expect(resolveTlonOutboundTarget("dm/sampel-palnet")).toEqual({
      ok: true,
      to: "~sampel-palnet",
    });
  });

  it("resolves group targets to canonical chat nests", () => {
    expect(resolveTlonOutboundTarget("group:host-ship/general")).toEqual({
      ok: true,
      to: "chat/~host-ship/general",
    });
  });

  it("returns a helpful error for invalid targets", () => {
    const resolved = resolveTlonOutboundTarget("group:bad-target");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected invalid target");
    }
    expect(resolved.error.message).toMatch(/invalid tlon target/i);
  });

  it("lists named accounts and the implicit default account", () => {
    const cfg = {
      channels: {
        tlon: {
          accounts: {
            Work: { ship: "~bus" },
            alerts: { ship: "~nec" },
          },
          ship: "~zod",
        },
      },
    } as OpenClawConfig;

    expect(listTlonAccountIds(cfg)).toEqual(["alerts", "default", "work"]);
  });

  it("merges named account config over channel defaults", () => {
    const resolved = resolveTlonAccount(
      {
        channels: {
          tlon: {
            accounts: {
              Work: {
                code: "work-code",
                dmAllowlist: ["~rovnys"],
                name: "Work",
              },
            },
            code: "base-code",
            defaultAuthorizedShips: ["~marzod"],
            dmAllowlist: ["~nec"],
            groupInviteAllowlist: ["~bus"],
            name: "Base",
            ship: "~zod",
            url: "https://urbit.example.com",
          },
        },
      } as OpenClawConfig,
      "work",
    );

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.ship).toBe("~zod");
    expect(resolved.url).toBe("https://urbit.example.com");
    expect(resolved.code).toBe("work-code");
    expect(resolved.dmAllowlist).toEqual(["~rovnys"]);
    expect(resolved.groupInviteAllowlist).toEqual(["~bus"]);
    expect(resolved.defaultAuthorizedShips).toEqual(["~marzod"]);
    expect(resolved.configured).toBe(true);
  });

  it("keeps the default account on channel-level config only", () => {
    const resolved = resolveTlonAccount(
      {
        channels: {
          tlon: {
            accounts: {
              default: {
                code: "ignored-code",
                ship: "~ignored",
              },
            },
            code: "base-code",
            ship: "~zod",
            url: "https://urbit.example.com",
          },
        },
      } as OpenClawConfig,
      "default",
    );

    expect(resolved.ship).toBe("~zod");
    expect(resolved.code).toBe("base-code");
  });

  it("setup status labels the selected account", async () => {
    const status = await tlonStatus({
      accountOverrides: { tlon: "work" },
      cfg: {
        channels: {
          tlon: {
            accounts: {
              work: {},
            },
            code: "base-code",
            ship: "~zod",
            url: "https://urbit.example.com",
          },
        },
      } as OpenClawConfig,
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toEqual(["Tlon (work): configured"]);
  });
});
