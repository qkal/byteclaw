import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAuthStatePath, resolveAuthStorePath } from "./auth-profiles/paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

vi.mock("./auth-profiles/external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

describe("saveAuthProfileStore", () => {
  it("strips plaintext when keyRef/tokenRef are present", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-"));
    try {
      const store: AuthProfileStore = {
        profiles: {
          "anthropic:default": {
            key: "sk-anthropic-plain",
            provider: "anthropic",
            type: "api_key",
          },
          "github-copilot:default": {
            provider: "github-copilot",
            token: "gh-runtime-token",
            tokenRef: { id: "GITHUB_TOKEN", provider: "default", source: "env" },
            type: "token",
          },
          "openai:default": {
            key: "sk-runtime-value",
            keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
            provider: "openai",
            type: "api_key",
          },
        },
        version: 1,
      };

      saveAuthProfileStore(store, agentDir);

      const parsed = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<
          string,
          { key?: string; keyRef?: unknown; token?: string; tokenRef?: unknown }
        >;
      };

      expect(parsed.profiles["openai:default"]?.key).toBeUndefined();
      expect(parsed.profiles["openai:default"]?.keyRef).toEqual({
        id: "OPENAI_API_KEY",
        provider: "default",
        source: "env",
      });

      expect(parsed.profiles["github-copilot:default"]?.token).toBeUndefined();
      expect(parsed.profiles["github-copilot:default"]?.tokenRef).toEqual({
        id: "GITHUB_TOKEN",
        provider: "default",
        source: "env",
      });

      expect(parsed.profiles["anthropic:default"]?.key).toBe("sk-anthropic-plain");
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("refreshes the runtime snapshot when a saved store rotates oauth tokens", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-runtime-"));
    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            profiles: {
              "anthropic:default": {
                access: "access-1",
                expires: 1,
                provider: "anthropic",
                refresh: "refresh-1",
                type: "oauth",
              },
            },
            version: 1,
          },
        },
      ]);

      expect(ensureAuthProfileStore(agentDir).profiles["anthropic:default"]).toMatchObject({
        access: "access-1",
        refresh: "refresh-1",
      });

      const rotatedStore: AuthProfileStore = {
        profiles: {
          "anthropic:default": {
            access: "access-2",
            expires: 2,
            provider: "anthropic",
            refresh: "refresh-2",
            type: "oauth",
          },
        },
        version: 1,
      };

      saveAuthProfileStore(rotatedStore, agentDir);

      expect(ensureAuthProfileStore(agentDir).profiles["anthropic:default"]).toMatchObject({
        access: "access-2",
        refresh: "refresh-2",
      });

      const persisted = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, { access?: string; refresh?: string }>;
      };
      expect(persisted.profiles["anthropic:default"]).toMatchObject({
        access: "access-2",
        refresh: "refresh-2",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("writes runtime scheduling state to auth-state.json only", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-state-"));
    try {
      const store: AuthProfileStore = {
        lastGood: {
          anthropic: "anthropic:default",
        },
        order: {
          anthropic: ["anthropic:default"],
        },
        profiles: {
          "anthropic:default": {
            key: "sk-anthropic-plain",
            provider: "anthropic",
            type: "api_key",
          },
        },
        usageStats: {
          "anthropic:default": {
            lastUsed: 123,
          },
        },
        version: 1,
      };

      saveAuthProfileStore(store, agentDir);

      const authProfiles = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
        order?: unknown;
        lastGood?: unknown;
        usageStats?: unknown;
      };
      expect(authProfiles.profiles["anthropic:default"]).toBeDefined();
      expect(authProfiles.order).toBeUndefined();
      expect(authProfiles.lastGood).toBeUndefined();
      expect(authProfiles.usageStats).toBeUndefined();

      const authState = JSON.parse(await fs.readFile(resolveAuthStatePath(agentDir), "utf8")) as {
        order?: Record<string, string[]>;
        lastGood?: Record<string, string>;
        usageStats?: Record<string, { lastUsed?: number }>;
      };
      expect(authState.order?.anthropic).toEqual(["anthropic:default"]);
      expect(authState.lastGood?.anthropic).toBe("anthropic:default");
      expect(authState.usageStats?.["anthropic:default"]?.lastUsed).toBe(123);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });
});
