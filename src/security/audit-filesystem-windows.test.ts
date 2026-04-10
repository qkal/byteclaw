import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectFilesystemFindings } from "./audit.js";

const windowsAuditEnv = {
  USERDOMAIN: "DESKTOP-TEST",
  USERNAME: "Tester",
};

describe("security audit filesystem Windows findings", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-audit-win-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { force: true, recursive: true }).catch(() => undefined);
  });

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  it("evaluates Windows ACL-derived filesystem findings", async () => {
    await Promise.all([
      (async () => {
        const tmp = await makeTmpDir("win");
        const stateDir = path.join(tmp, "state");
        await fs.mkdir(stateDir, { recursive: true });
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, "{}\n", "utf8");
        const findings = await collectFilesystemFindings({
          configPath,
          env: windowsAuditEnv,
          execIcacls: async (_cmd: string, args: string[]) => ({
            stderr: "",
            stdout: `${args[0]} NT AUTHORITY\\SYSTEM:(F)\n DESKTOP-TEST\\Tester:(F)\n`,
          }),
          platform: "win32",
          stateDir,
        });
        const forbidden = new Set([
          "fs.state_dir.perms_world_writable",
          "fs.state_dir.perms_group_writable",
          "fs.state_dir.perms_readable",
          "fs.config.perms_writable",
          "fs.config.perms_world_readable",
          "fs.config.perms_group_readable",
        ]);
        for (const id of forbidden) {
          expect(
            findings.some((finding) => finding.checkId === id),
            id,
          ).toBe(false);
        }
      })(),
      (async () => {
        const tmp = await makeTmpDir("win-open");
        const stateDir = path.join(tmp, "state");
        await fs.mkdir(stateDir, { recursive: true });
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, "{}\n", "utf8");
        const findings = await collectFilesystemFindings({
          configPath,
          env: windowsAuditEnv,
          execIcacls: async (_cmd: string, args: string[]) => {
            const target = args[0];
            if (target.endsWith(`${path.sep}state`)) {
              return {
                stderr: "",
                stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Users:(RX)\n DESKTOP-TEST\\Tester:(F)\n`,
              };
            }
            return {
              stderr: "",
              stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n DESKTOP-TEST\\Tester:(F)\n`,
            };
          },
          platform: "win32",
          stateDir,
        });
        expect(
          findings.some(
            (finding) =>
              finding.checkId === "fs.state_dir.perms_readable" && finding.severity === "warn",
          ),
        ).toBe(true);
      })(),
    ]);
  });
});
