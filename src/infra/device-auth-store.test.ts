import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "./device-auth-store.js";

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

function deviceAuthFile(stateDir: string): string {
  return path.join(stateDir, "identity", "device-auth.json");
}

describe("infra/device-auth-store", () => {
  it("stores and loads device auth tokens under the configured state dir", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      vi.spyOn(Date, "now").mockReturnValue(1234);

      const entry = storeDeviceAuthToken({
        deviceId: "device-1",
        env: createEnv(stateDir),
        role: " operator ",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        token: "secret",
      });

      expect(entry).toEqual({
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        token: "secret",
        updatedAtMs: 1234,
      });
      expect(
        loadDeviceAuthToken({
          deviceId: "device-1",
          env: createEnv(stateDir),
          role: "operator",
        }),
      ).toEqual(entry);

      const raw = await fs.readFile(deviceAuthFile(stateDir), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual({
        deviceId: "device-1",
        tokens: {
          operator: entry,
        },
        version: 1,
      });
    });
  });

  it("returns null for missing, invalid, or mismatched stores", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      expect(loadDeviceAuthToken({ deviceId: "device-1", env, role: "operator" })).toBeNull();

      await fs.mkdir(path.dirname(deviceAuthFile(stateDir)), { recursive: true });
      await fs.writeFile(deviceAuthFile(stateDir), '{"version":2,"deviceId":"device-1"}\n', "utf8");
      expect(loadDeviceAuthToken({ deviceId: "device-1", env, role: "operator" })).toBeNull();

      await fs.writeFile(
        deviceAuthFile(stateDir),
        '{"version":1,"deviceId":"device-2","tokens":{"operator":{"token":"x","role":"operator","scopes":[],"updatedAtMs":1}}}\n',
        "utf8",
      );
      expect(loadDeviceAuthToken({ deviceId: "device-1", env, role: "operator" })).toBeNull();
    });
  });

  it("clears only the requested role and leaves unrelated tokens intact", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-1",
        env,
        role: "operator",
        token: "operator-token",
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        env,
        role: "node",
        token: "node-token",
      });

      clearDeviceAuthToken({
        deviceId: "device-1",
        env,
        role: " operator ",
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", env, role: "operator" })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", env, role: "node" })).toMatchObject({
        token: "node-token",
      });
    });
  });
});
