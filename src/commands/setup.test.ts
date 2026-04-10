import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { setupCommand } from "./setup.js";

describe("setupCommand", () => {
  it("writes gateway.mode=local on first run", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        error: vi.fn(),
        exit: vi.fn(),
        log: vi.fn(),
      };

      await setupCommand(undefined, runtime);

      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const raw = await fs.readFile(configPath, "utf8");

      expect(raw).toContain('"mode": "local"');
      expect(raw).toContain('"workspace"');
    });
  });

  it("adds gateway.mode=local to an existing config without overwriting workspace", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        error: vi.fn(),
        exit: vi.fn(),
        log: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "custom-workspace");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace,
            },
          },
        }),
      );

      await setupCommand(undefined, runtime);

      const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        agents?: { defaults?: { workspace?: string } };
        gateway?: { mode?: string };
      };

      expect(raw.agents?.defaults?.workspace).toBe(workspace);
      expect(raw.gateway?.mode).toBe("local");
    });
  });

  it("treats non-object config roots as empty config", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        error: vi.fn(),
        exit: vi.fn(),
        log: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, '"not-an-object"', "utf8");

      await setupCommand(undefined, runtime);

      const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        agents?: { defaults?: { workspace?: string } };
        gateway?: { mode?: string };
      };

      expect(raw.agents?.defaults?.workspace).toBeTruthy();
      expect(raw.gateway?.mode).toBe("local");
    });
  });
});
