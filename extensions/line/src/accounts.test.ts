import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "./accounts.js";

describe("LINE accounts", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  const createSecretFile = (fileName: string, contents: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  describe("resolveLineAccount", () => {
    it("resolves account from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            channelAccessToken: "test-token",
            channelSecret: "test-secret",
            enabled: true,
            name: "Test Bot",
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("test-token");
      expect(account.channelSecret).toBe("test-secret");
      expect(account.name).toBe("Test Bot");
      expect(account.tokenSource).toBe("config");
    });

    it("resolves account from environment variables", () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "env-token";
      process.env.LINE_CHANNEL_SECRET = "env-secret";

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("env-token");
      expect(account.channelSecret).toBe("env-secret");
      expect(account.tokenSource).toBe("env");
    });

    it("resolves named account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              business: {
                channelAccessToken: "business-token",
                channelSecret: "business-secret",
                enabled: true,
                name: "Business Bot",
              },
            },
            enabled: true,
          },
        },
      };

      const account = resolveLineAccount({ accountId: "business", cfg });

      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("business-token");
      expect(account.channelSecret).toBe("business-secret");
      expect(account.name).toBe("Business Bot");
    });

    it("uses configured defaultAccount when accountId is omitted", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              business: {
                channelAccessToken: "business-token",
                channelSecret: "business-secret",
                enabled: true,
                name: "Business Bot",
              },
            },
            defaultAccount: "business",
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("business-token");
      expect(account.channelSecret).toBe("business-secret");
      expect(account.name).toBe("Business Bot");
    });

    it("returns empty token when not configured", () => {
      const cfg: OpenClawConfig = {};

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("");
      expect(account.channelSecret).toBe("");
      expect(account.tokenSource).toBe("none");
    });

    it("resolves default account credentials from files", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            secretFile: createSecretFile("secret.txt", "file-secret\n"),
            tokenFile: createSecretFile("token.txt", "file-token\n"),
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("file-token");
      expect(account.channelSecret).toBe("file-secret");
      expect(account.tokenSource).toBe("file");
    });

    it("resolves named account credentials from account-level files", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              business: {
                secretFile: createSecretFile("business-secret.txt", "business-file-secret\n"),
                tokenFile: createSecretFile("business-token.txt", "business-file-token\n"),
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ accountId: "business", cfg });

      expect(account.channelAccessToken).toBe("business-file-token");
      expect(account.channelSecret).toBe("business-file-secret");
      expect(account.tokenSource).toBe("file");
    });

    it.runIf(process.platform !== "win32")("rejects symlinked token and secret files", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
      tempDirs.push(dir);
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      const secretFile = path.join(dir, "secret.txt");
      const secretLink = path.join(dir, "secret-link.txt");
      fs.writeFileSync(tokenFile, "file-token\n", "utf8");
      fs.writeFileSync(secretFile, "file-secret\n", "utf8");
      fs.symlinkSync(tokenFile, tokenLink);
      fs.symlinkSync(secretFile, secretLink);

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            secretFile: secretLink,
            tokenFile: tokenLink,
          },
        },
      };

      const account = resolveLineAccount({ cfg });
      expect(account.channelAccessToken).toBe("");
      expect(account.channelSecret).toBe("");
      expect(account.tokenSource).toBe("none");
    });
  });

  describe("resolveDefaultLineAccountId", () => {
    it.each([
      {
        cfg: {
          channels: {
            line: {
              accounts: {
                business: { enabled: true },
                support: { enabled: true },
              },
              defaultAccount: "business",
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
        name: "prefers channels.line.defaultAccount when configured",
      },
      {
        cfg: {
          channels: {
            line: {
              accounts: {
                "business-ops": { enabled: true },
              },
              defaultAccount: "Business Ops",
            },
          },
        } satisfies OpenClawConfig,
        expected: "business-ops",
        name: "normalizes channels.line.defaultAccount before lookup",
      },
      {
        cfg: {
          channels: {
            line: {
              accounts: {
                business: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
        name: "returns first named account when default not configured",
      },
      {
        cfg: {
          channels: {
            line: {
              accounts: {
                business: { enabled: true },
              },
              defaultAccount: "missing",
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
        name: "falls back when channels.line.defaultAccount is missing",
      },
      {
        cfg: {
          channels: {
            line: {
              accounts: {
                business: { enabled: true },
              },
              channelAccessToken: "base-token",
            },
          },
        } satisfies OpenClawConfig,
        expected: DEFAULT_ACCOUNT_ID,
        name: "prefers the default account when base credentials are configured",
      },
    ])("$name", ({ cfg, expected }) => {
      expect(resolveDefaultLineAccountId(cfg)).toBe(expected);
    });
  });

  describe("normalizeAccountId", () => {
    it("trims and lowercases account ids", () => {
      expect(normalizeAccountId("  Business  ")).toBe("business");
    });
  });
});
