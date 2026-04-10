import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigMutationConflictError,
  mutateConfigFile,
  readSourceConfigSnapshot,
  replaceConfigFile,
} from "./config.js";
import { withTempHome } from "./home-env.test-harness.js";

describe("config mutate helpers", () => {
  it("mutates source config with optimistic hash protection", async () => {
    await withTempHome("openclaw-config-mutate-source-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 18_789 } }, null, 2)}\n`);

      const snapshot = await readSourceConfigSnapshot();
      await mutateConfigFile({
        base: "source",
        baseHash: snapshot.hash,
        mutate(draft) {
          draft.gateway = {
            ...draft.gateway,
            auth: { mode: "token" },
          };
        },
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        gateway?: { port?: number; auth?: unknown };
      };
      expect(persisted.gateway).toEqual({
        auth: { mode: "token" },
        port: 18_789,
      });
    });
  });

  it("rejects stale replace attempts when the base hash changed", async () => {
    await withTempHome("openclaw-config-replace-conflict-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 18_789 } }, null, 2)}\n`);

      const snapshot = await readSourceConfigSnapshot();
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 19_001 } }, null, 2)}\n`);

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          nextConfig: { gateway: { port: 19_002 } },
        }),
      ).rejects.toBeInstanceOf(ConfigMutationConflictError);
    });
  });
});
