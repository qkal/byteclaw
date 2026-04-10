import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type WizardPrompter,
  createPluginSetupWizardAdapter,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/plugins/start-account-lifecycle.js";
import {
  type ResolvedIrcAccount,
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
} from "./accounts.js";
import { startIrcGatewayAccount } from "./gateway.js";
import { clearIrcRuntime, setIrcRuntime } from "./runtime.js";
import {
  ircSetupAdapter,
  parsePort,
  setIrcAllowFrom,
  setIrcDmPolicy,
  setIrcGroupAccess,
  setIrcNickServ,
  updateIrcAccountConfig,
} from "./setup-core.js";
import { ircSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  monitorIrcProvider: vi.fn(),
  sendMessageIrc: vi.fn(),
}));

vi.mock("./channel-runtime.js", () => ({
  monitorIrcProvider: hoisted.monitorIrcProvider,
  sendMessageIrc: hoisted.sendMessageIrc,
}));

const ircSetupPlugin = {
  config: {
    defaultAccountId: resolveDefaultIrcAccountId,
    listAccountIds: listIrcAccountIds,
  },
  id: "irc",
  meta: {
    label: "IRC",
  },
  setupWizard: ircSetupWizard,
} as never;

const ircConfigureAdapter = createPluginSetupWizardAdapter(ircSetupPlugin);
const ircStatus = createPluginSetupWizardStatus(ircSetupPlugin);

function buildAccount(): ResolvedIrcAccount {
  return {
    accountId: "default",
    config: {} as ResolvedIrcAccount["config"],
    configured: true,
    enabled: true,
    host: "irc.example.com",
    name: "default",
    nick: "openclaw",
    password: "",
    passwordSource: "none",
    port: 6697,
    realname: "OpenClaw",
    tls: true,
    username: "openclaw",
  };
}

function installIrcRuntime() {
  setIrcRuntime({
    channel: {
      activity: {
        get: vi.fn(),
        record: vi.fn(),
      },
    },
    logging: {
      getChildLogger: vi.fn(() => ({
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      })),
      shouldLogVerbose: vi.fn(() => false),
    },
  } as never);
}

describe("irc setup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearIrcRuntime();
  });

  it("parses valid ports and falls back for invalid values", () => {
    expect(parsePort("6697", 6667)).toBe(6697);
    expect(parsePort(" 7000 ", 6667)).toBe(7000);
    expect(parsePort("", 6667)).toBe(6667);
    expect(parsePort("70000", 6667)).toBe(6667);
    expect(parsePort("abc", 6667)).toBe(6667);
  });

  it("updates top-level dm policy and allowlist", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(setIrcDmPolicy(cfg, "open")).toMatchObject({
      channels: {
        irc: {
          dmPolicy: "open",
        },
      },
    });

    expect(setIrcAllowFrom(cfg, ["alice", "bob"])).toMatchObject({
      channels: {
        irc: {
          allowFrom: ["alice", "bob"],
        },
      },
    });
  });

  it("setup status honors the selected named account", async () => {
    const status = await ircStatus({
      accountOverrides: {
        irc: "work",
      },
      cfg: {
        channels: {
          irc: {
            accounts: {
              ops: {
                host: "irc.example.com",
                nick: "ops-bot",
              },
              work: {
                host: "irc.example.com",
              },
            },
          },
        },
      } as CoreConfig,
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["IRC: needs host + nick"]);
  });

  it("setup status honors the configured default account", async () => {
    const status = await ircStatus({
      accountOverrides: {},
      cfg: {
        channels: {
          irc: {
            accounts: {
              ops: {
                host: "irc.example.com",
                nick: "ops-bot",
              },
              work: {
                host: "irc.example.com",
                nick: "",
              },
            },
            defaultAccount: "work",
          },
        },
      } as CoreConfig,
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["IRC: needs host + nick"]);
  });

  it("stores nickserv and account config patches on the scoped account", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(
      setIrcNickServ(cfg, "work", {
        enabled: true,
        service: "NickServ",
      }),
    ).toMatchObject({
      channels: {
        irc: {
          accounts: {
            work: {
              nickserv: {
                enabled: true,
                service: "NickServ",
              },
            },
          },
        },
      },
    });

    expect(
      updateIrcAccountConfig(cfg, "work", {
        host: "irc.libera.chat",
        nick: "openclaw-work",
      }),
    ).toMatchObject({
      channels: {
        irc: {
          accounts: {
            work: {
              host: "irc.libera.chat",
              nick: "openclaw-work",
            },
          },
        },
      },
    });
  });

  it("normalizes allowlist groups and handles non-allowlist policies", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(
      setIrcGroupAccess(
        cfg,
        "default",
        "allowlist",
        ["openclaw", "#ops", "openclaw", "*"],
        (raw) => {
          const trimmed = raw.trim();
          if (!trimmed) {
            return null;
          }
          if (trimmed === "*") {
            return "*";
          }
          return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
        },
      ),
    ).toMatchObject({
      channels: {
        irc: {
          enabled: true,
          groupPolicy: "allowlist",
          groups: {
            "#openclaw": {},
            "#ops": {},
            "*": {},
          },
        },
      },
    });

    expect(setIrcGroupAccess(cfg, "default", "disabled", [], () => null)).toMatchObject({
      channels: {
        irc: {
          enabled: true,
          groupPolicy: "disabled",
        },
      },
    });
  });

  it("validates required input and applies normalized account config", () => {
    const { validateInput } = ircSetupAdapter;
    const { applyAccountConfig } = ircSetupAdapter;
    expect(validateInput).toBeTypeOf("function");
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      validateInput!({
        input: { host: "", nick: "openclaw" },
      } as never),
    ).toBe("IRC requires host.");

    expect(
      validateInput!({
        input: { host: "irc.libera.chat", nick: "" },
      } as never),
    ).toBe("IRC requires nick.");

    expect(
      validateInput!({
        input: { host: "irc.libera.chat", nick: "openclaw" },
      } as never),
    ).toBeNull();

    expect(
      applyAccountConfig({
        accountId: "default",
        cfg: { channels: { irc: {} } },
        input: {
          channels: ["#openclaw"],
          host: " irc.libera.chat ",
          name: "Default",
          nick: " openclaw ",
          password: " secret ",
          port: "7000",
          realname: " OpenClaw Bot ",
          tls: true,
          username: " claw ",
        },
      } as never),
    ).toEqual({
      channels: {
        irc: {
          channels: ["#openclaw"],
          enabled: true,
          host: "irc.libera.chat",
          name: "Default",
          nick: "openclaw",
          password: "secret",
          port: 7000,
          realname: "OpenClaw Bot",
          tls: true,
          username: "claw",
        },
      },
    });
  });

  it("configures host and nick via setup prompts", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Use TLS for IRC?") {
          return true;
        }
        if (message === "Configure IRC channels access?") {
          return true;
        }
        return false;
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "IRC server host") {
          return "irc.libera.chat";
        }
        if (message === "IRC server port") {
          return "6697";
        }
        if (message === "IRC nick") {
          return "openclaw-bot";
        }
        if (message === "IRC username") {
          return "openclaw";
        }
        if (message === "IRC real name") {
          return "OpenClaw Bot";
        }
        if (message.startsWith("Auto-join IRC channels")) {
          return "#openclaw, #ops";
        }
        if (message.startsWith("IRC channels allowlist")) {
          return "#openclaw, #ops";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      cfg: {} as CoreConfig,
      configure: ircConfigureAdapter.configure,
      options: {},
      prompter,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.irc?.enabled).toBe(true);
    expect(result.cfg.channels?.irc?.host).toBe("irc.libera.chat");
    expect(result.cfg.channels?.irc?.nick).toBe("openclaw-bot");
    expect(result.cfg.channels?.irc?.tls).toBe(true);
    expect(result.cfg.channels?.irc?.channels).toEqual(["#openclaw", "#ops"]);
    expect(result.cfg.channels?.irc?.groupPolicy).toBe("allowlist");
    expect(Object.keys(result.cfg.channels?.irc?.groups ?? {})).toEqual(["#openclaw", "#ops"]);
  });

  it("writes DM allowFrom to top-level config for non-default account prompts", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async () => false),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "IRC allowFrom (nick or nick!user@host)") {
          return "Alice, Bob!ident@example.org";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const promptAllowFrom = ircConfigureAdapter.dmPolicy?.promptAllowFrom;
    if (!promptAllowFrom) {
      throw new Error("promptAllowFrom unavailable");
    }

    const cfg: CoreConfig = {
      channels: {
        irc: {
          accounts: {
            work: {
              host: "irc.libera.chat",
              nick: "openclaw-work",
            },
          },
        },
      },
    };

    const updated = (await promptSetupWizardAllowFrom({
      accountId: "work",
      cfg,
      promptAllowFrom,
      prompter,
    })) as CoreConfig;

    expect(updated.channels?.irc?.allowFrom).toEqual(["alice", "bob!ident@example.org"]);
    expect(updated.channels?.irc?.accounts?.work?.allowFrom).toBeUndefined();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = vi.fn();
    hoisted.monitorIrcProvider.mockResolvedValue({ stop });
    installIrcRuntime();

    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      account: buildAccount(),
      startAccount: async (ctx) =>
        await startIrcGatewayAccount({
          ...ctx,
          cfg: ctx.cfg as CoreConfig,
        }),
    });

    await expectStopPendingUntilAbort({
      abort,
      isSettled,
      stop,
      task,
      waitForStarted: waitForStartedMocks(hoisted.monitorIrcProvider),
    });
  });
});
