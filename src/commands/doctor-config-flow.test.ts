import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { resolveMatrixAccountStorageRoot } from "../plugin-sdk/matrix.js";
import * as noteModule from "../terminal/note.js";
import { setChannelPluginRegistryForTests } from "./channel-test-registry.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

function expectGoogleChatDmAllowFromRepaired(cfg: unknown) {
  const typed = cfg as {
    channels: {
      googlechat: {
        dm: { allowFrom: string[] };
        allowFrom?: string[];
      };
    };
  };
  expect(typed.channels.googlechat.dm.allowFrom).toEqual(["*"]);
  expect(typed.channels.googlechat.allowFrom).toBeUndefined();
}

async function collectDoctorWarnings(config: Record<string, unknown>): Promise<string[]> {
  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  try {
    await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    return noteSpy.mock.calls
      .filter((call) => call[1] === "Doctor warnings")
      .map((call) => String(call[0]));
  } finally {
    noteSpy.mockRestore();
  }
}

interface DiscordGuildRule {
  users: string[];
  roles: string[];
  channels: Record<string, { users: string[]; roles: string[] }>;
}

interface DiscordAccountRule {
  allowFrom?: string[];
  dm?: { allowFrom: string[]; groupChannels: string[] };
  execApprovals?: { approvers: string[] };
  guilds?: Record<string, DiscordGuildRule>;
}

interface RepairedDiscordPolicy {
  allowFrom?: string[];
  dm: { allowFrom: string[]; groupChannels: string[] };
  execApprovals: { approvers: string[] };
  guilds: Record<string, DiscordGuildRule>;
  accounts: Record<string, DiscordAccountRule>;
}

describe("doctor config flow", () => {
  beforeEach(() => {
    setChannelPluginRegistryForTests([
      "discord",
      "googlechat",
      "imessage",
      "matrix",
      "slack",
      "telegram",
      "whatsapp",
      "zalouser",
    ]);
  });

  it("preserves invalid config for doctor repairs", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: { list: [{ id: "pi" }] },
        gateway: { auth: { mode: "token", token: 123 } },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect((result.cfg as Record<string, unknown>).gateway).toEqual({
      auth: { mode: "token", token: 123 },
    });
  });

  it("does not warn on mutable account allowlists when dangerous name matching is inherited", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        slack: {
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
          dangerouslyAllowNameMatching: true,
        },
      },
    });
    expect(doctorWarnings.some((line) => line.includes("mutable allowlist"))).toBe(false);
  });

  it("does not warn about sender-based group allowlist for googlechat", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        googlechat: {
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
          groupPolicy: "allowlist",
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) => line.includes('groupPolicy is "allowlist"') && line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
  });

  it("shows first-time Telegram guidance without the old groupAllowFrom warning", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.telegram.groupPolicy is "allowlist"') &&
          line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
    expect(
      doctorWarnings.some(
        (line) =>
          line.includes("channels.telegram: Telegram is in first-time setup mode.") &&
          line.includes("DMs use pairing mode") &&
          line.includes("channels.telegram.groups"),
      ),
    ).toBe(true);
  });

  it("shows account-scoped first-time Telegram guidance without the old groupAllowFrom warning", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "123:abc",
              groupPolicy: "allowlist",
            },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.telegram.accounts.default.groupPolicy is "allowlist"') &&
          line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
    expect(
      doctorWarnings.some(
        (line) =>
          line.includes(
            "channels.telegram.accounts.default: Telegram is in first-time setup mode.",
          ) &&
          line.includes("DMs use pairing mode") &&
          line.includes("channels.telegram.accounts.default.groups"),
      ),
    ).toBe(true);
  });

  it("shows plugin-blocked guidance instead of first-time Telegram guidance when telegram is explicitly disabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
        },
      },
      plugins: {
        entries: {
          telegram: {
            enabled: false,
          },
        },
      },
    });

    expect(
      doctorWarnings.some((line) =>
        line.includes(
          'channels.telegram: channel is configured, but plugin "telegram" is disabled by plugins.entries.telegram.enabled=false.',
        ),
      ),
    ).toBe(true);
    expect(doctorWarnings.some((line) => line.includes("first-time setup mode"))).toBe(false);
  });

  it("shows plugin-blocked guidance instead of first-time Telegram guidance when plugins are disabled globally", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
        },
      },
      plugins: {
        enabled: false,
      },
    });

    expect(
      doctorWarnings.some((line) =>
        line.includes(
          "channels.telegram: channel is configured, but plugins.enabled=false blocks channel plugins globally.",
        ),
      ),
    ).toBe(true);
    expect(doctorWarnings.some((line) => line.includes("first-time setup mode"))).toBe(false);
  });

  it("warns on mutable Zalouser group entries when dangerous name matching is disabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        zalouser: {
          groups: {
            "Ops Room": { allow: true },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes("mutable allowlist") && line.includes("channels.zalouser.groups: Ops Room"),
      ),
    ).toBe(true);
  });

  it("does not warn on mutable Zalouser group entries when dangerous name matching is enabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        zalouser: {
          dangerouslyAllowNameMatching: true,
          groups: {
            "Ops Room": { allow: true },
          },
        },
      },
    });

    expect(doctorWarnings.some((line) => line.includes("channels.zalouser.groups"))).toBe(false);
  });

  it("warns when imessage group allowlist is empty even if allowFrom is set", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        imessage: {
          allowFrom: ["+15551234567"],
          groupPolicy: "allowlist",
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.imessage.groupPolicy is "allowlist"') &&
          line.includes("does not fall back to allowFrom"),
      ),
    ).toBe(true);
  });

  it("drops unknown keys on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: { list: [{ id: "pi" }] },
        bridge: { bind: "auto" },
        gateway: { auth: { extra: true, mode: "token", token: "ok" } },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as Record<string, unknown>;
    expect(cfg.bridge).toBeUndefined();
    expect((cfg.gateway as Record<string, unknown>)?.auth).toEqual({
      mode: "token",
      token: "ok",
    });
  });

  it("migrates legacy browser extension profiles to existing-session on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        browser: {
          profiles: {
            chromeLive: {
              color: "#00AA00",
              driver: "extension",
            },
          },
          relayBindHost: "0.0.0.0",
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const browser = (result.cfg as { browser?: Record<string, unknown> }).browser ?? {};
    expect(browser.relayBindHost).toBeUndefined();
    expect(
      ((browser.profiles as Record<string, { driver?: string }>)?.chromeLive ?? {}).driver,
    ).toBe("existing-session");
  });

  it("repairs restrictive plugins.allow when browser is referenced via tools.alsoAllow", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        plugins: {
          allow: ["telegram"],
        },
        tools: {
          alsoAllow: ["browser"],
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.cfg.plugins?.allow).toEqual(["telegram", "browser"]);
    expect(result.cfg.plugins?.entries?.browser?.enabled).toBe(true);
  });

  it("previews Matrix legacy sync-store migration in read-only mode", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify({
            channels: {
              matrix: {
                accessToken: "tok-123",
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
              },
            },
          }),
        );
        await fs.writeFile(
          path.join(stateDir, "matrix", "bot-storage.json"),
          '{"next_batch":"s1"}',
        );
        await loadAndMaybeMigrateDoctorConfig({
          confirm: async () => false,
          options: { nonInteractive: true },
        });
      });

      const warning = noteSpy.mock.calls.find(
        (call) =>
          call[1] === "Doctor warnings" &&
          String(call[0]).includes("Matrix plugin upgraded in place."),
      );
      expect(warning?.[0]).toContain("Legacy sync store:");
      expect(warning?.[0]).toContain(
        'Run "openclaw doctor --fix" to migrate this Matrix state now.',
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("previews Matrix encrypted-state migration in read-only mode", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const { rootDir: accountRoot } = resolveMatrixAccountStorageRoot({
          accessToken: "tok-123",
          homeserver: "https://matrix.example.org",
          stateDir,
          userId: "@bot:example.org",
        });
        await fs.mkdir(path.join(accountRoot, "crypto"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify({
            channels: {
              matrix: {
                accessToken: "tok-123",
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
              },
            },
          }),
        );
        await fs.writeFile(
          path.join(accountRoot, "crypto", "bot-sdk.json"),
          JSON.stringify({ deviceId: "DEVICE123" }),
        );
        await loadAndMaybeMigrateDoctorConfig({
          confirm: async () => false,
          options: { nonInteractive: true },
        });
      });

      const warning = noteSpy.mock.calls.find(
        (call) =>
          call[1] === "Doctor warnings" &&
          String(call[0]).includes("Matrix encrypted-state migration is pending"),
      );
      expect(warning?.[0]).toContain("Legacy crypto store:");
      expect(warning?.[0]).toContain("New recovery key file:");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("migrates Matrix legacy state on doctor repair", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify({
            channels: {
              matrix: {
                accessToken: "tok-123",
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
              },
            },
          }),
        );
        await fs.writeFile(
          path.join(stateDir, "matrix", "bot-storage.json"),
          '{"next_batch":"s1"}',
        );
        await loadAndMaybeMigrateDoctorConfig({
          confirm: async () => false,
          options: { nonInteractive: true, repair: true },
        });

        const migratedRoot = path.join(
          stateDir,
          "matrix",
          "accounts",
          "default",
          "matrix.example.org__bot_example.org",
        );
        const migratedChildren = await fs.readdir(migratedRoot);
        expect(migratedChildren.length).toBe(1);
        expect(
          await fs
            .access(path.join(migratedRoot, migratedChildren[0] ?? "", "bot-storage.json"))
            .then(() => true)
            .catch(() => false),
        ).toBe(true);
        expect(
          await fs
            .access(path.join(stateDir, "matrix", "bot-storage.json"))
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
      });

      expect(
        noteSpy.mock.calls.some(
          (call) =>
            call[1] === "Doctor changes" &&
            String(call[0]).includes("Matrix plugin upgraded in place."),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("creates a Matrix migration snapshot before doctor repair mutates Matrix state", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          channels: {
            matrix: {
              accessToken: "tok-123",
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
            },
          },
        }),
      );
      await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');

      await loadAndMaybeMigrateDoctorConfig({
        confirm: async () => false,
        options: { nonInteractive: true, repair: true },
      });

      const snapshotDir = path.join(home, "Backups", "openclaw-migrations");
      const snapshotEntries = await fs.readdir(snapshotDir);
      expect(snapshotEntries.some((entry) => entry.endsWith(".tar.gz"))).toBe(true);

      const marker = JSON.parse(
        await fs.readFile(path.join(stateDir, "matrix", "migration-snapshot.json"), "utf8"),
      ) as {
        archivePath: string;
      };
      expect(marker.archivePath).toContain(path.join("Backups", "openclaw-migrations"));
    });
  });

  it("warns when Matrix is installed from a stale custom path", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        matrix: {
          accessToken: "tok-123",
          homeserver: "https://matrix.example.org",
        },
      },
      plugins: {
        installs: {
          matrix: {
            installPath: "/tmp/openclaw-matrix-missing",
            source: "path",
            sourcePath: "/tmp/openclaw-matrix-missing",
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) => line.includes("custom path") && line.includes("/tmp/openclaw-matrix-missing"),
      ),
    ).toBe(true);
  });

  it("warns when Matrix is installed from an existing custom path", async () => {
    await withTempHome(async (home) => {
      const pluginPath = path.join(home, "matrix-plugin");
      await fs.mkdir(pluginPath, { recursive: true });

      const doctorWarnings = await collectDoctorWarnings({
        channels: {
          matrix: {
            accessToken: "tok-123",
            homeserver: "https://matrix.example.org",
          },
        },
        plugins: {
          installs: {
            matrix: {
              installPath: pluginPath,
              source: "path",
              sourcePath: pluginPath,
            },
          },
        },
      });

      expect(
        doctorWarnings.some((line) => line.includes("Matrix is installed from a custom path")),
      ).toBe(true);
      expect(
        doctorWarnings.some((line) => line.includes("will not automatically replace that plugin")),
      ).toBe(true);
    });
  });

  it("notes legacy browser extension migration changes", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        browser: {
          profiles: {
            chromeLive: {
              color: "#00AA00",
              driver: "extension",
            },
          },
          relayBindHost: "127.0.0.1",
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const browser = (result.cfg as { browser?: Record<string, unknown> }).browser ?? {};
    expect(browser.relayBindHost).toBeUndefined();
    expect(
      ((browser.profiles as Record<string, { driver?: string }>)?.chromeLive ?? {}).driver,
    ).toBe("existing-session");
  });

  it("preserves discord streaming intent while stripping unsupported keys on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            lifecycle: {
              enabled: true,
              reactions: {
                done: "✅",
                error: "❌",
                queued: "⏳",
                thinking: "🧠",
                tool: "🔧",
              },
            },
            streaming: true,
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        discord: {
          streamMode?: string;
          streaming?: {
            mode?: string;
          };
          lifecycle?: unknown;
        };
      };
    };
    expect(cfg.channels.discord.streaming?.mode).toBe("partial");
    expect(cfg.channels.discord.streamMode).toBeUndefined();
    expect(cfg.channels.discord.lifecycle).toEqual({
      enabled: true,
      reactions: {
        done: "✅",
        error: "❌",
        queued: "⏳",
        thinking: "🧠",
        tool: "🔧",
      },
    });
  });

  it("warns clearly about legacy channel streaming aliases and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          channels: {
            discord: {
              streaming: false,
            },
            googlechat: {
              streamMode: "append",
            },
            slack: {
              streaming: true,
            },
            telegram: {
              streamMode: "block",
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.telegram:") &&
            String(message).includes("channels.telegram.streamMode, channels.telegram.streaming"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.discord:") &&
            String(message).includes("channels.discord.streamMode, channels.discord.streaming"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.googlechat:") &&
            String(message).includes("channels.googlechat.streamMode is legacy and no longer used"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.slack:") &&
            String(message).includes("channels.slack.streamMode, channels.slack.streaming"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("repairs legacy googlechat streamMode by removing it", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          googlechat: {
            accounts: {
              work: {
                streamMode: "replace",
              },
            },
            streamMode: "append",
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        googlechat: {
          accounts?: {
            work?: Record<string, unknown>;
          };
        } & Record<string, unknown>;
      };
    };
    expect(cfg.channels.googlechat.streamMode).toBeUndefined();
    expect(cfg.channels.googlechat.accounts?.work?.streamMode).toBeUndefined();
  });

  it("warns clearly about legacy nested channel allow aliases and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          channels: {
            discord: {
              guilds: {
                "100": {
                  channels: {
                    general: {
                      allow: false,
                    },
                  },
                },
              },
            },
            googlechat: {
              groups: {
                "spaces/aaa": {
                  allow: false,
                },
              },
            },
            slack: {
              channels: {
                ops: {
                  allow: false,
                },
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.slack:") &&
            String(message).includes("channels.slack.channels.<id>.allow is legacy"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.googlechat:") &&
            String(message).includes("channels.googlechat.groups.<id>.allow is legacy"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.discord:") &&
            String(message).includes("channels.discord.guilds.<id>.channels.<id>.allow is legacy"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("repairs legacy nested channel allow aliases on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            guilds: {
              "100": {
                channels: {
                  general: {
                    allow: false,
                  },
                },
              },
            },
          },
          googlechat: {
            groups: {
              "spaces/aaa": {
                allow: false,
              },
            },
          },
          slack: {
            channels: {
              ops: {
                allow: false,
              },
            },
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(result.cfg.channels?.slack?.channels?.ops).toEqual({
      enabled: false,
    });
    expect(result.cfg.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({
      enabled: false,
    });
    expect(result.cfg.channels?.discord?.guilds?.["100"]?.channels?.general).toEqual({
      enabled: false,
    });
  });

  it("sanitizes config-derived doctor warnings and changes before logging", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          channels: {
            slack: {
              accounts: {
                "ops\u001b[31m\nopen": {
                  dmPolicy: "open",
                },
                work: {
                  allowFrom: ["alice\u001b[31m\nforged"],
                },
              },
            },
            telegram: {
              accounts: {
                work: {
                  allowFrom: ["@\u001b[31mtestuser"],
                  botToken: "tok",
                },
              },
            },
            whatsapp: {
              accounts: {
                "ops\u001b[31m\nempty": {
                  groupPolicy: "allowlist",
                },
              },
            },
          },
        },
        repair: true,
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const outputs = noteSpy.mock.calls
        .filter((call) => call[1] === "Doctor warnings" || call[1] === "Doctor changes")
        .map((call) => String(call[0]));
      const joinedOutputs = outputs.join("\n");
      expect(outputs.filter((line) => line.includes("\u001b"))).toEqual([]);
      expect(outputs.filter((line) => line.includes("\nforged"))).toEqual([]);
      expect(joinedOutputs).toContain('channels.slack.accounts.opsopen.allowFrom: set to ["*"]');
      expect(joinedOutputs).toContain('required by dmPolicy="open"');
      expect(
        outputs.some(
          (line) =>
            line.includes('channels.whatsapp.accounts.opsempty.groupPolicy is "allowlist"') &&
            line.includes("groupAllowFrom"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns and continues when Telegram account inspection hits inactive SecretRef surfaces", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await runDoctorConfigWithInput({
        config: {
          channels: {
            telegram: {
              accounts: {
                inactive: {
                  allowFrom: ["@testuser"],
                  botToken: { id: "TELEGRAM_BOT_TOKEN", provider: "default", source: "env" },
                  enabled: false,
                },
              },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        },
        repair: true,
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const cfg = result.cfg as {
        channels?: {
          telegram?: {
            accounts?: Record<string, { allowFrom?: string[] }>;
          };
        };
      };
      expect(cfg.channels?.telegram?.accounts?.inactive?.allowFrom).toEqual(["@testuser"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        noteSpy.mock.calls.some((call) =>
          String(call[0]).includes("Telegram account inactive: failed to inspect bot token"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            "Telegram allowFrom contains @username entries, but configured Telegram bot credentials are unavailable in this command path",
          ),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("converts numeric discord ids to strings on repair", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            channels: {
              discord: {
                accounts: {
                  work: {
                    allowFrom: [555],
                    dm: { allowFrom: [666], groupChannels: [777] },
                    execApprovals: { approvers: [888] },
                    guilds: {
                      "200": {
                        channels: {
                          help: { roles: [1212], users: [1111] },
                        },
                        roles: [1010],
                        users: [999],
                      },
                    },
                  },
                },
                allowFrom: [123],
                dm: { allowFrom: [456], groupChannels: [789] },
                execApprovals: { approvers: [321] },
                guilds: {
                  "100": {
                    channels: {
                      general: { roles: [444], users: [333] },
                    },
                    roles: [222],
                    users: [111],
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        confirm: async () => false,
        options: { nonInteractive: true, repair: true },
      });

      const cfg = result.cfg as unknown as {
        channels: {
          discord: Omit<RepairedDiscordPolicy, "allowFrom"> & {
            allowFrom?: string[];
            accounts: Record<string, DiscordAccountRule> & {
              default: { allowFrom: string[] };
              work: {
                allowFrom: string[];
                dm: { allowFrom: string[]; groupChannels: string[] };
                execApprovals: { approvers: string[] };
                guilds: Record<string, DiscordGuildRule>;
              };
            };
          };
        };
      };

      expect(cfg.channels.discord.allowFrom).toBeUndefined();
      expect(cfg.channels.discord.dm.allowFrom).toEqual(["456"]);
      expect(cfg.channels.discord.dm.groupChannels).toEqual(["789"]);
      expect(cfg.channels.discord.execApprovals.approvers).toEqual(["321"]);
      expect(cfg.channels.discord.guilds["100"].users).toEqual(["111"]);
      expect(cfg.channels.discord.guilds["100"].roles).toEqual(["222"]);
      expect(cfg.channels.discord.guilds["100"].channels.general.users).toEqual(["333"]);
      expect(cfg.channels.discord.guilds["100"].channels.general.roles).toEqual(["444"]);
      expect(cfg.channels.discord.accounts.default.allowFrom).toEqual(["123"]);
      expect(cfg.channels.discord.accounts.work.allowFrom).toEqual(["555"]);
      expect(cfg.channels.discord.accounts.work.dm.allowFrom).toEqual(["666"]);
      expect(cfg.channels.discord.accounts.work.dm.groupChannels).toEqual(["777"]);
      expect(cfg.channels.discord.accounts.work.execApprovals.approvers).toEqual(["888"]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].users).toEqual(["999"]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].roles).toEqual(["1010"]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].channels.help.users).toEqual([
        "1111",
      ]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].channels.help.roles).toEqual([
        "1212",
      ]);
    });
  });

  it("does not restore top-level allowFrom when config is intentionally default-account scoped", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["123"], token: "discord-default-token" },
              work: { token: "discord-work-token" },
            },
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        discord: {
          allowFrom?: string[];
          accounts: Record<string, { allowFrom?: string[] }>;
        };
      };
    };

    expect(cfg.channels.discord.allowFrom).toBeUndefined();
    expect(cfg.channels.discord.accounts.default.allowFrom).toEqual(["123"]);
  });

  it('adds allowFrom ["*"] when dmPolicy="open" and allowFrom is missing on repair', async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            dmPolicy: "open",
            groupPolicy: "open",
            token: "test-token",
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { discord: { allowFrom: string[]; dmPolicy: string } };
    };
    expect(cfg.channels.discord.allowFrom).toEqual(["*"]);
    expect(cfg.channels.discord.dmPolicy).toBe("open");
  });

  it("adds * to existing allowFrom array when dmPolicy is open on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          slack: {
            allowFrom: ["U123"],
            appToken: "xapp-test",
            botToken: "xoxb-test",
            dmPolicy: "open",
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { slack: { allowFrom: string[] } };
    };
    expect(cfg.channels.slack.allowFrom).toContain("*");
    expect(cfg.channels.slack.allowFrom).toContain("U123");
  });

  it("repairs nested dm.allowFrom when top-level allowFrom is absent on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            dm: { allowFrom: ["123"] },
            dmPolicy: "open",
            token: "test-token",
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { discord: { dm: { allowFrom: string[] }; allowFrom?: string[] } };
    };
    // When dmPolicy is set at top level but allowFrom only exists nested in dm,
    // The repair adds "*" to dm.allowFrom
    if (cfg.channels.discord.dm) {
      expect(cfg.channels.discord.dm.allowFrom).toContain("*");
      expect(cfg.channels.discord.dm.allowFrom).toContain("123");
    } else {
      // If doctor flattened the config, allowFrom should be at top level
      expect(cfg.channels.discord.allowFrom).toContain("*");
    }
  });

  it("skips repair when allowFrom already includes *", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            allowFrom: ["*"],
            dmPolicy: "open",
            token: "test-token",
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { discord: { allowFrom: string[] } };
    };
    expect(cfg.channels.discord.allowFrom).toEqual(["*"]);
  });

  it("repairs per-account dmPolicy open without allowFrom on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            accounts: {
              work: {
                dmPolicy: "open",
                token: "test-token-2",
              },
            },
            token: "test-token",
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        discord: { accounts: { work: { allowFrom: string[]; dmPolicy: string } } };
      };
    };
    expect(cfg.channels.discord.accounts.work.allowFrom).toEqual(["*"]);
  });

  it('repairs dmPolicy="allowlist" by restoring allowFrom from pairing store on repair', async () => {
    const result = await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const credentialsDir = path.join(configDir, "credentials");
      await fs.mkdir(credentialsDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            channels: {
              telegram: {
                botToken: "fake-token",
                dmPolicy: "allowlist",
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(
        path.join(credentialsDir, "telegram-allowFrom.json"),
        JSON.stringify({ allowFrom: ["12345"], version: 1 }, null, 2),
        "utf8",
      );
      return await loadAndMaybeMigrateDoctorConfig({
        confirm: async () => false,
        options: { nonInteractive: true, repair: true },
      });
    });

    const cfg = result.cfg as {
      channels: {
        telegram: {
          dmPolicy: string;
          allowFrom: string[];
        };
      };
    };
    expect(cfg.channels.telegram.dmPolicy).toBe("allowlist");
    expect(cfg.channels.telegram.allowFrom).toEqual(["12345"]);
  });

  it("migrates legacy toolsBySender keys to typed id entries on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          whatsapp: {
            groups: {
              "123@g.us": {
                toolsBySender: {
                  "*": { deny: ["exec"] },
                  alice: { deny: ["exec"] },
                  "id:owner": { deny: ["exec"] },
                  owner: { allow: ["exec"] },
                  "username:@ops-bot": { allow: ["fs.read"] },
                },
              },
            },
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: Record<string, { allow?: string[]; deny?: string[] }>;
            };
          };
        };
      };
    };
    const { toolsBySender } = cfg.channels.whatsapp.groups["123@g.us"];
    expect(toolsBySender.owner).toBeUndefined();
    expect(toolsBySender.alice).toBeUndefined();
    expect(toolsBySender["id:owner"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["id:alice"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["username:@ops-bot"]).toEqual({ allow: ["fs.read"] });
    expect(toolsBySender["*"]).toEqual({ deny: ["exec"] });
  });

  it("repairs googlechat dm.policy open by setting dm.allowFrom on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          googlechat: {
            dm: {
              policy: "open",
            },
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expectGoogleChatDmAllowFromRepaired(result.cfg);
  });

  it("migrates top-level heartbeat into agents.defaults.heartbeat on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        heartbeat: {
          every: "30m",
          model: "anthropic/claude-3-5-haiku-20241022",
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      heartbeat?: unknown;
      agents?: {
        defaults?: {
          heartbeat?: {
            model?: string;
            every?: string;
          };
        };
      };
    };
    expect(cfg.heartbeat).toBeUndefined();
    expect(cfg.agents?.defaults?.heartbeat).toMatchObject({
      every: "30m",
      model: "anthropic/claude-3-5-haiku-20241022",
    });
  });

  it("warns clearly about legacy config keys and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          heartbeat: {
            every: "30m",
            model: "anthropic/claude-3-5-haiku-20241022",
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("heartbeat:") &&
            String(message).includes("agents.defaults.heartbeat"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns clearly about legacy heartbeat visibility config and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          heartbeat: {
            showAlerts: false,
            showOk: true,
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("heartbeat:") &&
            String(message).includes("channels.defaults.heartbeat"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns clearly about legacy memorySearch config and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          memorySearch: {
            fallback: "none",
            provider: "local",
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("memorySearch:") &&
            String(message).includes("agents.defaults.memorySearch"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("repairs legacy gateway.bind host aliases on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        gateway: {
          bind: "0.0.0.0",
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      gateway?: {
        bind?: string;
      };
    };
    expect(cfg.gateway?.bind).toBe("lan");
  });

  it("warns clearly about legacy gateway.bind host aliases and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          gateway: {
            bind: "localhost",
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("gateway.bind:") &&
            String(message).includes("gateway.bind host aliases"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Doctor" &&
            String(message).includes('Run "openclaw doctor --fix" to migrate legacy config keys.'),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns clearly about legacy telegram groupMentionsOnly config and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          channels: {
            telegram: {
              groupMentionsOnly: true,
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("channels.telegram.groupMentionsOnly:") &&
            String(message).includes("channels.telegram.groups"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Doctor" &&
            String(message).includes('Run "openclaw doctor --fix" to migrate legacy config keys.'),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns clearly about legacy x_search auth config and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          tools: {
            web: {
              x_search: {
                apiKey: "test-key",
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("tools.web.x_search.apiKey:") &&
            String(message).includes("plugins.entries.xai.config.webSearch.apiKey"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Doctor" &&
            String(message).includes('Run "openclaw doctor --fix" to migrate legacy config keys.'),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns clearly about legacy hooks.internal.handlers and requires manual migration", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          hooks: {
            internal: {
              handlers: [{ event: "command:new", module: "hooks/legacy-handler.js" }],
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("hooks.internal.handlers:") &&
            String(message).includes("HOOK.md + handler.js"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("does not rewrite this shape automatically"),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns clearly about legacy thread binding ttlHours config and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          channels: {
            discord: {
              accounts: {
                alpha: {
                  threadBindings: {
                    ttlHours: 6,
                  },
                },
              },
              threadBindings: {
                ttlHours: 12,
              },
            },
          },
          session: {
            threadBindings: {
              ttlHours: 24,
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const legacyMessages = noteSpy.mock.calls
        .filter(([, title]) => title === "Legacy config keys detected")
        .map(([message]) => String(message))
        .join("\n");

      expect(legacyMessages).toContain("session.threadBindings.ttlHours");
      expect(legacyMessages).toContain("session.threadBindings.idleHours");
      expect(legacyMessages).toContain("channels.<id>.threadBindings.ttlHours");
      expect(legacyMessages).toContain("channels.<id>.threadBindings.idleHours");
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Doctor" &&
            String(message).includes('Run "openclaw doctor --fix" to migrate legacy config keys.'),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("repairs legacy thread binding ttlHours config on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          discord: {
            accounts: {
              alpha: {
                threadBindings: {
                  ttlHours: 6,
                },
              },
            },
            threadBindings: {
              ttlHours: 12,
            },
          },
        },
        session: {
          threadBindings: {
            ttlHours: 24,
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      session?: {
        threadBindings?: {
          idleHours?: number;
          ttlHours?: number;
        };
      };
      channels?: {
        discord?: {
          threadBindings?: {
            idleHours?: number;
            ttlHours?: number;
          };
          accounts?: Record<
            string,
            {
              threadBindings?: {
                idleHours?: number;
                ttlHours?: number;
              };
            }
          >;
        };
      };
    };
    expect(cfg.session?.threadBindings).toMatchObject({
      idleHours: 24,
    });
    expect(cfg.channels?.discord?.threadBindings).toMatchObject({
      idleHours: 12,
    });
    expect(cfg.channels?.discord?.accounts?.alpha?.threadBindings).toMatchObject({
      idleHours: 6,
    });
    expect(cfg.session?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.discord?.threadBindings?.ttlHours).toBeUndefined();
    expect(cfg.channels?.discord?.accounts?.alpha?.threadBindings?.ttlHours).toBeUndefined();
  });

  it("warns clearly about legacy talk config and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          talk: {
            modelId: "eleven_v3",
            voiceId: "voice-1",
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("talk:") &&
            String(message).includes(
              "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
            ),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("warns clearly about legacy sandbox perSession config and points to doctor --fix", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          agents: {
            defaults: {
              sandbox: {
                perSession: true,
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Legacy config keys detected" &&
            String(message).includes("agents.defaults.sandbox:") &&
            String(message).includes("agents.defaults.sandbox.perSession is legacy"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some(
          ([message, title]) =>
            title === "Doctor" &&
            String(message).includes('Run "openclaw doctor --fix" to migrate legacy config keys.'),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("migrates top-level heartbeat visibility into channels.defaults.heartbeat on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        heartbeat: {
          showAlerts: false,
          showOk: true,
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      heartbeat?: unknown;
      channels?: {
        defaults?: {
          heartbeat?: {
            showOk?: boolean;
            showAlerts?: boolean;
            useIndicator?: boolean;
          };
        };
      };
    };
    expect(cfg.heartbeat).toBeUndefined();
    expect(cfg.channels?.defaults?.heartbeat).toMatchObject({
      showAlerts: false,
      showOk: true,
    });
  });

  it("repairs googlechat account dm.policy open by setting dm.allowFrom on repair", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          googlechat: {
            accounts: {
              work: {
                dm: {
                  policy: "open",
                },
              },
            },
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        googlechat: {
          accounts: {
            work: {
              dm: {
                policy: string;
                allowFrom: string[];
              };
              allowFrom?: string[];
            };
          };
        };
      };
    };

    expect(cfg.channels.googlechat.accounts.work.dm.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.accounts.work.allowFrom).toBeUndefined();
  });

  it("recovers from stale googlechat top-level allowFrom by repairing dm.allowFrom", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        channels: {
          googlechat: {
            allowFrom: ["*"],
            dm: {
              policy: "open",
            },
          },
        },
      },
      repair: true,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    const cfg = result.cfg as {
      channels: {
        googlechat: {
          dm: { allowFrom: string[] };
          allowFrom?: string[];
        };
      };
    };
    expect(cfg.channels.googlechat.dm.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.allowFrom).toEqual(["*"]);
  });

  it("does not report repeat talk provider normalization on consecutive repair runs", async () => {
    await withTempHome(async (home) => {
      const providerId = "acme-speech";
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            talk: {
              interruptOnSpeech: true,
              provider: providerId,
              providers: {
                [providerId]: {
                  apiKey: "secret-key",
                  modelId: "eleven_v3",
                  voiceId: "voice-123",
                },
              },
              silenceTimeoutMs: 1500,
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
      try {
        await loadAndMaybeMigrateDoctorConfig({
          confirm: async () => false,
          options: { nonInteractive: true, repair: true },
        });
        noteSpy.mockClear();

        await loadAndMaybeMigrateDoctorConfig({
          confirm: async () => false,
          options: { nonInteractive: true, repair: true },
        });
        const secondRunTalkNormalizationLines = noteSpy.mock.calls
          .filter((call) => call[1] === "Doctor changes")
          .map((call) => String(call[0]))
          .filter((line) => line.includes("Normalized talk.provider/providers shape"));
        expect(secondRunTalkNormalizationLines).toEqual([]);
      } finally {
        noteSpy.mockRestore();
      }
    });
  });
});
