import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { collectIncludeFilePermFindings } from "./audit-extra.async.js";

const isWindows = process.platform === "win32";

describe("security audit config include permissions", () => {
  it("flags group/world-readable config include files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-include-perms-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { mode: 0o700, recursive: true });

    const includePath = path.join(stateDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf8");
    if (isWindows) {
      const { execSync } = await import("node:child_process");
      execSync(`icacls "${includePath}" /grant Everyone:W`, { stdio: "ignore" });
    } else {
      await fs.chmod(includePath, 0o644);
    }

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, `{ "$include": "./extra.json5" }\n`, "utf8");
    await fs.chmod(configPath, 0o600);

    const user = String.raw`DESKTOP-TEST\Tester`;
    const execIcacls = isWindows
      ? async (_cmd: string, args: string[]) => {
          const target = args[0];
          if (target === includePath) {
            return {
              stderr: "",
              stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Users:(W)\n ${user}:(F)\n`,
            };
          }
          return {
            stderr: "",
            stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n ${user}:(F)\n`,
          };
        }
      : undefined;

    const configSnapshot: ConfigFileSnapshot = {
      config: {} as ConfigFileSnapshot["config"],
      exists: true,
      issues: [],
      legacyIssues: [],
      parsed: { $include: "./extra.json5" },
      path: configPath,
      raw: `{ "$include": "./extra.json5" }\n`,
      resolved: {} as ConfigFileSnapshot["resolved"],
      runtimeConfig: {} as ConfigFileSnapshot["runtimeConfig"],
      sourceConfig: {} as ConfigFileSnapshot["sourceConfig"],
      valid: true,
      warnings: [],
    };

    const findings = await collectIncludeFilePermFindings({
      configSnapshot,
      env: isWindows
        ? { ...process.env, USERDOMAIN: "DESKTOP-TEST", USERNAME: "Tester" }
        : undefined,
      execIcacls,
      platform: isWindows ? "win32" : undefined,
    });

    const expectedCheckId = isWindows
      ? "fs.config_include.perms_writable"
      : "fs.config_include.perms_world_readable";

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: expectedCheckId, severity: "critical" }),
      ]),
    );
  });
});
