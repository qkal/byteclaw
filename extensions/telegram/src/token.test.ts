import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../../../src/test-helpers/state-dir-env.js";
import { resolveTelegramToken } from "./token.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";

describe("resolveTelegramToken", () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-token-"));
    tempDirs.push(dir);
    return dir;
  }

  function createTokenFile(fileName: string, contents = "file-token\n"): string {
    const dir = createTempDir();
    const tokenFile = path.join(dir, fileName);
    fs.writeFileSync(tokenFile, contents, "utf8");
    return tokenFile;
  }

  function createUnknownAccountConfig(): OpenClawConfig {
    return {
      channels: {
        telegram: {
          accounts: {
            knownBot: { botToken: "known-bot-token" },
          },
          botToken: "wrong-bot-token",
        },
      },
    } as OpenClawConfig;
  }

  function expectNoTokenForUnknownAccount(cfg: OpenClawConfig) {
    const res = resolveTelegramToken(cfg, { accountId: "unknownBot" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each([
    {
      cfg: {
        channels: { telegram: { botToken: "cfg-token" } },
      } as OpenClawConfig,
      envToken: "env-token",
      expected: { source: "config", token: "cfg-token" },
      name: "prefers config token over env",
    },
    {
      cfg: {
        channels: { telegram: {} },
      } as OpenClawConfig,
      envToken: "env-token",
      expected: { source: "env", token: "env-token" },
      name: "uses env token when config is missing",
    },
    {
      cfg: {
        channels: { telegram: { tokenFile: "" } },
      } as OpenClawConfig,
      envToken: "",
      expected: { source: "tokenFile", token: "file-token" },
      name: "uses tokenFile when configured",
      resolveCfg: () =>
        ({
          channels: { telegram: { tokenFile: createTokenFile("token.txt") } },
        }) as OpenClawConfig,
    },
    {
      cfg: {
        channels: { telegram: { botToken: "cfg-token" } },
      } as OpenClawConfig,
      envToken: "",
      expected: { source: "config", token: "cfg-token" },
      name: "falls back to config token when no env or tokenFile",
    },
  ])("$name", ({ envToken, cfg, resolveCfg, expected }) => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", envToken);
    const res = resolveTelegramToken(resolveCfg ? resolveCfg() : cfg);
    expect(res).toEqual(expected);
  });

  it.runIf(process.platform !== "win32")("rejects symlinked tokenFile paths", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = createTempDir();
    const tokenFile = path.join(dir, "token.txt");
    const tokenLink = path.join(dir, "token-link.txt");
    fs.writeFileSync(tokenFile, "file-token\n", "utf8");
    fs.symlinkSync(tokenFile, tokenLink);

    const cfg = { channels: { telegram: { tokenFile: tokenLink } } } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not fall back to config when tokenFile is missing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = createTempDir();
    const tokenFile = path.join(dir, "missing-token.txt");
    const cfg = {
      channels: { telegram: { botToken: "cfg-token", tokenFile } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("resolves per-account tokens when the config account key casing doesn't match routing normalization", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            // Note the mixed-case key; runtime accountId is normalized.
            careyNotifications: { botToken: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "careynotifications" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("resolves per-account tokens when config keys normalize spaces to dashes", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            "Carey Notifications": { botToken: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "carey-notifications" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("falls back to top-level token for non-default accounts without account token", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {},
          },
          botToken: "top-level-token",
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("top-level-token");
    expect(res.source).toBe("config");
  });

  it("uses account-level tokenFile before top-level fallbacks", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {
              tokenFile: createTokenFile("account-token.txt", "account-file-token\n"),
            },
          },
          botToken: "top-level-token",
          tokenFile: createTokenFile("top-level-token.txt", "top-level-file-token\n"),
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("account-file-token");
    expect(res.source).toBe("tokenFile");
  });

  it("falls back to top-level tokenFile for non-default accounts", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {},
          },
          tokenFile: createTokenFile("token.txt"),
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("file-token");
    expect(res.source).toBe("tokenFile");
  });

  it("does not use env token for non-default accounts", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not fall through to channel-level token when non-default accountId is not in config", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expectNoTokenForUnknownAccount(createUnknownAccountConfig());
  });

  it("throws when botToken is an unresolved SecretRef object", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { id: "TELEGRAM_BOT_TOKEN", provider: "default", source: "env" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /channels\.telegram\.botToken: unresolved SecretRef/i,
    );
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  // Binding-created accountIds should inherit the channel-level token in
  // Single-bot setups (no accounts section).
  it("falls through to channel-level token for binding-created accountId without accounts section", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "channel-level-token",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "bot-main" });
    expect(res.token).toBe("channel-level-token");
    expect(res.source).toBe("config");
  });

  it("still blocks fallthrough for unknown accountId when accounts section exists", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expectNoTokenForUnknownAccount(createUnknownAccountConfig());
  });
});

describe("telegram update offset store", () => {
  it("persists and reloads the last update id", async () => {
    await withStateDirEnv("openclaw-telegram-", async () => {
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();

      await writeTelegramUpdateOffset({
        accountId: "primary",
        updateId: 421,
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBe(421);
    });
  });
});
