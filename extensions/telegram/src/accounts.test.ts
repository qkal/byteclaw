import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as runtimeEnvModule from "openclaw/plugin-sdk/runtime-env";
import { withEnv } from "openclaw/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramActionGate,
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resetMissingDefaultWarnFlag,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  resolveTelegramMediaRuntimeOptions,
  resolveTelegramPollActionGateState,
} from "./accounts.js";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

function warningLines(): string[] {
  return warnMock.mock.calls.map(([line]) => String(line));
}

function expectNoMissingDefaultWarning() {
  expect(warningLines().every((line) => !line.includes("accounts.default is missing"))).toBe(true);
}

function resolveAccountWithEnv(
  env: Record<string, string>,
  cfg: OpenClawConfig,
  accountId?: string,
) {
  return withEnv(env, () => resolveTelegramAccount({ cfg, ...(accountId ? { accountId } : {}) }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(runtimeEnvModule, "createSubsystemLogger").mockImplementation(() => {
    const logger = {
      child: () => logger,
      warn: warnMock,
    };
    return logger as unknown as ReturnType<typeof runtimeEnvModule.createSubsystemLogger>;
  });
});

describe("resolveTelegramAccount", () => {
  afterEach(() => {
    warnMock.mockClear();
    resetMissingDefaultWarnFlag();
  });

  it("falls back to the first configured account when accountId is omitted", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "" },
      {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      },
    );
    expect(account.accountId).toBe("work");
    expect(account.token).toBe("tok-work");
    expect(account.tokenSource).toBe("config");
  });

  it("uses TELEGRAM_BOT_TOKEN when default account config is missing", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "tok-env" },
      {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      },
    );
    expect(account.accountId).toBe("default");
    expect(account.token).toBe("tok-env");
    expect(account.tokenSource).toBe("env");
  });

  it("prefers default config token over TELEGRAM_BOT_TOKEN", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "tok-env" },
      {
        channels: {
          telegram: { botToken: "tok-config" },
        },
      },
    );
    expect(account.accountId).toBe("default");
    expect(account.token).toBe("tok-config");
    expect(account.tokenSource).toBe("config");
  });

  it("does not fall back when accountId is explicitly provided", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "" },
      {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      },
      "default",
    );
    expect(account.accountId).toBe("default");
    expect(account.tokenSource).toBe("none");
    expect(account.token).toBe("");
  });

  it("formats debug logs with inspect-style output when debug env is enabled", () => {
    withEnv({ OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS: "1", TELEGRAM_BOT_TOKEN: "" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      expect(listTelegramAccountIds(cfg)).toEqual(["work"]);
      resolveTelegramAccount({ accountId: "work", cfg });
    });

    const lines = warnMock.mock.calls.map(([line]) => String(line));
    expect(lines).toContain("listTelegramAccountIds [ 'work' ]");
    expect(lines).toContain("resolve { accountId: 'work', enabled: true, tokenSource: 'config' }");
  });
});

describe("resolveDefaultTelegramAccountId", () => {
  beforeEach(() => {
    resetMissingDefaultWarnFlag();
  });

  afterEach(() => {
    warnMock.mockClear();
    resetMissingDefaultWarnFlag();
  });

  it("warns when accounts.default is missing in multi-account setup (#32137)", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { alerts: { botToken: "tok-alerts" }, work: { botToken: "tok-work" } },
        },
      },
    };

    const result = resolveDefaultTelegramAccountId(cfg);
    expect(result).toBe("alerts");
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("accounts.default is missing"));
  });

  it("does not warn when accounts.default exists", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { default: { botToken: "tok-default" }, work: { botToken: "tok-work" } },
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    expectNoMissingDefaultWarning();
  });

  it("does not warn when defaultAccount is explicitly set", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { work: { botToken: "tok-work" } },
          defaultAccount: "work",
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    expectNoMissingDefaultWarning();
  });

  it("does not warn when only one non-default account is configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { work: { botToken: "tok-work" } },
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    expectNoMissingDefaultWarning();
  });

  it("warns only once per process lifetime", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { alerts: { botToken: "tok-alerts" }, work: { botToken: "tok-work" } },
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    resolveDefaultTelegramAccountId(cfg);
    resolveDefaultTelegramAccountId(cfg);

    const missingDefaultWarns = warningLines().filter((line) =>
      line.includes("accounts.default is missing"),
    );
    expect(missingDefaultWarns).toHaveLength(1);
  });

  it("prefers channels.telegram.defaultAccount when it matches a configured account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { default: { botToken: "tok-default" }, work: { botToken: "tok-work" } },
          defaultAccount: "work",
        },
      },
    };

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("work");
  });

  it("normalizes channels.telegram.defaultAccount before lookup", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { "router-d": { botToken: "tok-work" } },
          defaultAccount: "Router D",
        },
      },
    };

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("router-d");
  });

  it("falls back when channels.telegram.defaultAccount is not configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { default: { botToken: "tok-default" }, work: { botToken: "tok-work" } },
          defaultAccount: "missing",
        },
      },
    };

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("default");
  });
});

describe("resolveTelegramAccount allowFrom precedence", () => {
  it("prefers accounts.default allowlists over top-level for default account", () => {
    const resolved = resolveTelegramAccount({
      accountId: "default",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              default: {
                allowFrom: ["default"],
                botToken: "123:default",
                groupAllowFrom: ["default-group"],
              },
            },
            allowFrom: ["top"],
            groupAllowFrom: ["top-group"],
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
    expect(resolved.config.groupAllowFrom).toEqual(["default-group"]);
  });

  it("falls back to top-level allowlists for named account without overrides", () => {
    const resolved = resolveTelegramAccount({
      accountId: "work",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              work: { botToken: "123:work" },
            },
            allowFrom: ["top"],
            groupAllowFrom: ["top-group"],
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
    expect(resolved.config.groupAllowFrom).toEqual(["top-group"]);
  });

  it("does not inherit default account allowlists for named account when top-level is absent", () => {
    const resolved = resolveTelegramAccount({
      accountId: "work",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              default: {
                allowFrom: ["default"],
                botToken: "123:default",
                groupAllowFrom: ["default-group"],
              },
              work: { botToken: "123:work" },
            },
          },
        },
      },
    });

    expect(resolved.config.allowFrom).toBeUndefined();
    expect(resolved.config.groupAllowFrom).toBeUndefined();
  });
});

describe("mergeTelegramAccountConfig", () => {
  it("inherits top-level policy fallback for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            bot1: {
              botToken: "bot-1-token",
              enabled: true,
            },
            bot2: {
              botToken: "bot-2-token",
              enabled: true,
            },
          },
          allowFrom: ["123"],
          dmPolicy: "allowlist",
          enabled: true,
          groupPolicy: "allowlist",
        },
      },
    };

    expect(mergeTelegramAccountConfig(cfg, "bot1")).toMatchObject({
      allowFrom: ["123"],
      botToken: "bot-1-token",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
    });
    expect(mergeTelegramAccountConfig(cfg, "bot2")).toMatchObject({
      allowFrom: ["123"],
      botToken: "bot-2-token",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
    });
  });

  it("keeps top-level policy fallback when auth lives in accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "legacy-token",
            },
          },
          allowFrom: ["123"],
          dmPolicy: "allowlist",
          enabled: true,
          groupPolicy: "allowlist",
        },
      },
    };

    expect(mergeTelegramAccountConfig(cfg, "default")).toMatchObject({
      allowFrom: ["123"],
      botToken: "legacy-token",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
    });
  });
});

describe("resolveTelegramPollActionGateState", () => {
  it("requires both sendMessage and poll actions", () => {
    const state = resolveTelegramPollActionGateState((key) => key !== "poll");
    expect(state).toEqual({
      enabled: false,
      pollEnabled: false,
      sendMessageEnabled: true,
    });
  });

  it("returns enabled only when both actions are enabled", () => {
    const state = resolveTelegramPollActionGateState(() => true);
    expect(state).toEqual({
      enabled: true,
      pollEnabled: true,
      sendMessageEnabled: true,
    });
  });

  it("uses configured defaultAccount when telegram action gate accountId is omitted", () => {
    const gate = createTelegramActionGate({
      cfg: {
        channels: {
          telegram: {
            accounts: {
              work: {
                actions: { poll: true, sendMessage: true },
                botToken: "123:work",
              },
            },
            actions: { poll: false, sendMessage: false },
            defaultAccount: "work",
          },
        },
      },
    });

    expect(gate("sendMessage")).toBe(true);
    expect(gate("poll")).toBe(true);
  });
});

describe("resolveTelegramAccount groups inheritance (#30673)", () => {
  const createMultiAccountGroupsConfig = (): OpenClawConfig => ({
    channels: {
      telegram: {
        accounts: {
          default: { botToken: "123:default" },
          dev: { botToken: "456:dev" },
        },
        groups: { "-100123": { requireMention: false } },
      },
    },
  });

  const createDefaultAccountGroupsConfig = (includeDevAccount: boolean): OpenClawConfig => ({
    channels: {
      telegram: {
        accounts: {
          default: {
            botToken: "123:default",
            groups: { "-100123": { requireMention: false } },
          },
          ...(includeDevAccount ? { dev: { botToken: "456:dev" } } : {}),
        },
        groups: { "-100999": { requireMention: true } },
      },
    },
  });

  it("inherits channel-level groups in single-account setup", () => {
    const resolved = resolveTelegramAccount({
      accountId: "default",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "123:default" },
            },
            groups: { "-100123": { requireMention: false } },
          },
        },
      },
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });

  it("does NOT inherit channel-level groups to secondary account in multi-account setup", () => {
    const resolved = resolveTelegramAccount({
      accountId: "dev",
      cfg: createMultiAccountGroupsConfig(),
    });

    expect(resolved.config.groups).toBeUndefined();
  });

  it("does NOT inherit channel-level groups to default account in multi-account setup", () => {
    const resolved = resolveTelegramAccount({
      accountId: "default",
      cfg: createMultiAccountGroupsConfig(),
    });

    expect(resolved.config.groups).toBeUndefined();
  });

  it("uses account-level groups even in multi-account setup", () => {
    const resolved = resolveTelegramAccount({
      accountId: "default",
      cfg: createDefaultAccountGroupsConfig(true),
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });

  it("account-level groups takes priority over channel-level in single-account setup", () => {
    const resolved = resolveTelegramAccount({
      accountId: "default",
      cfg: createDefaultAccountGroupsConfig(false),
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });
});

describe("resolveTelegramMediaRuntimeOptions", () => {
  it("uses per-account network overrides for Telegram media downloads", () => {
    const resolved = resolveTelegramMediaRuntimeOptions({
      accountId: "work",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              work: {
                apiRoot: "http://tg-proxy.internal:8081",
                botToken: "123:work",
                network: {
                  dangerouslyAllowPrivateNetwork: true,
                },
                trustedLocalFileRoots: ["/var/lib/telegram-bot-api"],
              },
            },
            apiRoot: "https://api.telegram.org",
            network: {
              dangerouslyAllowPrivateNetwork: false,
            },
            trustedLocalFileRoots: ["/srv/telegram/cache"],
          },
        },
      },
      token: "123:work",
    });

    expect(resolved).toEqual({
      apiRoot: "http://tg-proxy.internal:8081",
      dangerouslyAllowPrivateNetwork: true,
      token: "123:work",
      transport: undefined,
      trustedLocalFileRoots: ["/var/lib/telegram-bot-api"],
    });
  });

  it("falls back to top-level Telegram media settings when account override is absent", () => {
    const resolved = resolveTelegramMediaRuntimeOptions({
      accountId: "work",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              work: {
                botToken: "123:work",
              },
            },
            apiRoot: "http://tg-proxy.internal:8081",
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            trustedLocalFileRoots: ["/srv/telegram/cache"],
          },
        },
      },
      token: "123:work",
    });

    expect(resolved).toEqual({
      apiRoot: "http://tg-proxy.internal:8081",
      dangerouslyAllowPrivateNetwork: true,
      token: "123:work",
      transport: undefined,
      trustedLocalFileRoots: ["/srv/telegram/cache"],
    });
  });
});
