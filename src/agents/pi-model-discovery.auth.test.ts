import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePiCredentialMapFromStore } from "./pi-auth-credentials.js";
import {
  addEnvBackedPiCredentials,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
} from "./pi-model-discovery.js";

async function createAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-auth-storage-"));
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await createAgentDir();
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { force: true, recursive: true });
  }
}

async function writeLegacyAuthJson(
  agentDir: string,
  authEntries: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(authEntries, null, 2));
}

async function readLegacyAuthJson(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("discoverAuthStorage", () => {
  it("converts runtime auth profiles into pi discovery credentials", () => {
    const credentials = resolvePiCredentialMapFromStore({
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          token: "sk-ant-runtime",
          type: "token",
        },
        "openai-codex:default": {
          access: "oauth-access",
          expires: Date.now() + 60_000,
          provider: "openai-codex",
          refresh: "oauth-refresh",
          type: "oauth",
        },
        "openrouter:default": {
          key: "sk-or-v1-runtime",
          provider: "openrouter",
          type: "api_key",
        },
      },
      version: 1,
    });

    expect(credentials.openrouter).toEqual({
      key: "sk-or-v1-runtime",
      type: "api_key",
    });
    expect(credentials.anthropic).toEqual({
      key: "sk-ant-runtime",
      type: "api_key",
    });
    expect(credentials["openai-codex"]).toMatchObject({
      access: "oauth-access",
      refresh: "oauth-refresh",
      type: "oauth",
    });
  });

  it("scrubs static api_key entries from legacy auth.json and keeps oauth entries", async () => {
    await withAgentDir(async (agentDir) => {
      await writeLegacyAuthJson(agentDir, {
        "openai-codex": {
          access: "oauth-access",
          expires: Date.now() + 60_000,
          refresh: "oauth-refresh",
          type: "oauth",
        },
        openrouter: { key: "legacy-static-key", type: "api_key" },
      });

      scrubLegacyStaticAuthJsonEntriesForDiscovery(path.join(agentDir, "auth.json"));

      const parsed = await readLegacyAuthJson(agentDir);
      expect(parsed.openrouter).toBeUndefined();
      expect(parsed["openai-codex"]).toMatchObject({
        access: "oauth-access",
        type: "oauth",
      });
    });
  });

  it("preserves legacy auth.json when auth store is forced read-only", async () => {
    await withAgentDir(async (agentDir) => {
      const previous = process.env.OPENCLAW_AUTH_STORE_READONLY;
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      try {
        await writeLegacyAuthJson(agentDir, {
          openrouter: { key: "legacy-static-key", type: "api_key" },
        });

        scrubLegacyStaticAuthJsonEntriesForDiscovery(path.join(agentDir, "auth.json"));

        const parsed = await readLegacyAuthJson(agentDir);
        expect(parsed.openrouter).toMatchObject({ key: "legacy-static-key", type: "api_key" });
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_AUTH_STORE_READONLY;
        } else {
          process.env.OPENCLAW_AUTH_STORE_READONLY = previous;
        }
      }
    });
  });

  it("includes env-backed provider auth when no auth profile exists", async () => {
    const previousMistral = process.env.MISTRAL_API_KEY;
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const previousDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.MISTRAL_API_KEY = "mistral-env-test-key";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    try {
      const credentials = addEnvBackedPiCredentials({}, process.env);

      expect(credentials.mistral).toEqual({
        key: "mistral-env-test-key",
        type: "api_key",
      });
    } finally {
      if (previousMistral === undefined) {
        delete process.env.MISTRAL_API_KEY;
      } else {
        process.env.MISTRAL_API_KEY = previousMistral;
      }
      if (previousBundledPluginsDir === undefined) {
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      } else {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
      }
      if (previousDisableBundledPlugins === undefined) {
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      } else {
        process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundledPlugins;
      }
    }
  });
});
