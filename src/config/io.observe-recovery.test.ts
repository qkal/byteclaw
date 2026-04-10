import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ObserveRecoveryDeps,
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
} from "./io.observe-recovery.js";

describe("config observe recovery", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fsp.mkdir(home, { recursive: true });
    return await fn(home);
  }

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-observe-recovery-"));
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { force: true, recursive: true });
  });

  async function seedConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  function makeDeps(
    home: string,
    warn = vi.fn(),
  ): {
    deps: ObserveRecoveryDeps;
    configPath: string;
    auditPath: string;
    warn: ReturnType<typeof vi.fn>;
  } {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      auditPath: path.join(home, ".openclaw", "logs", "config-audit.jsonl"),
      configPath,
      deps: {
        env: {} as NodeJS.ProcessEnv,
        fs,
        homedir: () => home,
        json5: JSON5,
        logger: { warn },
      },
      warn,
    };
  }

  it("auto-restores suspicious update-channel-only roots from backup", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfig(configPath, {
        browser: { enabled: true },
        channels: { discord: { dmPolicy: "pairing", enabled: true } },
        gateway: { auth: { mode: "token", token: "secret-token" }, mode: "local" },
        update: { channel: "beta" },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf8");

      const recovered = await maybeRecoverSuspiciousConfigRead({
        configPath,
        deps,
        parsed: { update: { channel: "beta" } },
        raw: clobberedRaw,
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf8")).resolves.not.toBe(clobberedRaw);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config auto-restored from backup:"),
      );

      const lines = (await fsp.readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe")
        .at(-1);
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.suspicious).toEqual(
        expect.arrayContaining(["gateway-mode-missing-vs-last-good", "update-channel-only-root"]),
      );
    });
  });

  it("dedupes repeated suspicious hashes", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfig(configPath, {
        channels: { telegram: { dmPolicy: "pairing", enabled: true, groupPolicy: "allowlist" } },
        gateway: { mode: "local" },
        update: { channel: "beta" },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf8");

      await maybeRecoverSuspiciousConfigRead({
        configPath,
        deps,
        parsed: { update: { channel: "beta" } },
        raw: clobberedRaw,
      });
      await maybeRecoverSuspiciousConfigRead({
        configPath,
        deps,
        parsed: { update: { channel: "beta" } },
        raw: clobberedRaw,
      });

      const lines = (await fsp.readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
      const observeEvents = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe");
      expect(observeEvents).toHaveLength(1);
    });
  });

  it("sync recovery uses backup baseline when health state is absent", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfig(configPath, {
        channels: { telegram: { dmPolicy: "pairing", enabled: true, groupPolicy: "allowlist" } },
        gateway: { mode: "local" },
        update: { channel: "beta" },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf8");

      const recovered = maybeRecoverSuspiciousConfigReadSync({
        configPath,
        deps,
        parsed: { update: { channel: "beta" } },
        raw: clobberedRaw,
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      const lines = (await fsp.readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe")
        .at(-1);
      expect(observe?.backupHash).toBeTypeOf("string");
      expect(observe?.lastKnownGoodIno ?? null).toBeNull();
    });
  });
});
