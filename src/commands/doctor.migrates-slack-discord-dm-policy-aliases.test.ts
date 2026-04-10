import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, writeConfigFile } from "./doctor.e2e-harness.js";

const DOCTOR_MIGRATION_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 45_000;
const { doctorCommand } = await import("./doctor.js");

describe("doctor command", () => {
  it(
    "does not rewrite supported Slack/Discord dm.policy aliases",
    { timeout: DOCTOR_MIGRATION_TIMEOUT_MS },
    async () => {
      readConfigFileSnapshot.mockResolvedValue({
        config: {
          channels: {
            discord: { dm: { allowFrom: ["123"], enabled: true, policy: "allowlist" } },
            slack: { dm: { allowFrom: ["*"], enabled: true, policy: "open" } },
          },
        },
        exists: true,
        issues: [],
        legacyIssues: [],
        parsed: {
          channels: {
            discord: {
              dm: { allowFrom: ["123"], enabled: true, policy: "allowlist" },
            },
            slack: { dm: { allowFrom: ["*"], enabled: true, policy: "open" } },
          },
        },
        path: "/tmp/openclaw.json",
        raw: "{}",
        valid: true,
      });

      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
      writeConfigFile.mockClear();

      await doctorCommand(runtime, { nonInteractive: true, repair: true });

      expect(writeConfigFile).not.toHaveBeenCalled();
    },
  );
});
