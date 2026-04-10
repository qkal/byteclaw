import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { withEnv } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { inspectTelegramAccount } from "./account-inspect.js";

describe("inspectTelegramAccount SecretRef resolution", () => {
  it("resolves default env SecretRef templates in read-only status paths", () => {
    withEnv({ TG_STATUS_TOKEN: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "${TG_STATUS_TOKEN}",
          },
        },
      };

      const account = inspectTelegramAccount({ accountId: "default", cfg });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("available");
      expect(account.token).toBe("123:token");
    });
  });

  it("respects env provider allowlists in read-only status paths", () => {
    withEnv({ TG_NOT_ALLOWED: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "${TG_NOT_ALLOWED}",
          },
        },
        secrets: {
          defaults: {
            env: "secure-env",
          },
          providers: {
            "secure-env": {
              allowlist: ["TG_ALLOWED"],
              source: "env",
            },
          },
        },
      };

      const account = inspectTelegramAccount({ accountId: "default", cfg });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
    });
  });

  it("does not read env values for non-env providers", () => {
    withEnv({ TG_EXEC_PROVIDER: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "${TG_EXEC_PROVIDER}",
          },
        },
        secrets: {
          defaults: {
            env: "exec-provider",
          },
          providers: {
            "exec-provider": {
              command: "/usr/bin/env",
              source: "exec",
            },
          },
        },
      };

      const account = inspectTelegramAccount({ accountId: "default", cfg });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
    });
  });

  it.runIf(process.platform !== "win32")(
    "treats symlinked token files as configured_unavailable",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-inspect-"));
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      fs.writeFileSync(tokenFile, "123:token\n", "utf8");
      fs.symlinkSync(tokenFile, tokenLink);

      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            tokenFile: tokenLink,
          },
        },
      };

      const account = inspectTelegramAccount({ accountId: "default", cfg });
      expect(account.tokenSource).toBe("tokenFile");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
      fs.rmSync(dir, { force: true, recursive: true });
    },
  );
});
