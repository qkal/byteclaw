import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";
import { resolveApiKeyFromProfiles } from "./models-config.providers.secrets.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

vi.mock("./models-config.providers.policy.runtime.js", () => ({
  applyProviderNativeStreamingUsagePolicy: () => undefined,
  normalizeProviderConfigPolicy: () => undefined,
  resolveProviderConfigApiKeyPolicy: () => undefined,
}));

describe("normalizeProviders", () => {
  const createModel = (
    overrides: Partial<
      NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["models"][number]
    > = {},
  ) => ({
    contextWindow: 8192,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: "config-model",
    input: ["text"] as ("text" | "image")[],
    maxTokens: 2048,
    name: "Config model",
    reasoning: false,
    ...overrides,
  });

  it("trims provider keys so image models remain discoverable for custom providers", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        " dashscope-vision ": {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api: "openai-completions",
          apiKey: "DASHSCOPE_API_KEY", // Pragma: allowlist secret
          models: [
            {
              contextWindow: 32_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "qwen-vl-max",
              input: ["text", "image"],
              maxTokens: 4096,
              name: "Qwen VL Max",
              reasoning: false,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ agentDir, providers });
      expect(Object.keys(normalized ?? {})).toEqual(["dashscope-vision"]);
      expect(normalized?.["dashscope-vision"]?.models?.[0]?.id).toBe("qwen-vl-max");
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("keeps the latest provider config when duplicate keys only differ by whitespace", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        " openai ": {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          apiKey: "CUSTOM_OPENAI_API_KEY", // Pragma: allowlist secret
          models: [
            {
              contextWindow: 128000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "gpt-4.1-mini",
              input: ["text"],
              maxTokens: 16384,
              name: "GPT-4.1 mini",
              reasoning: false,
            },
          ],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "OPENAI_API_KEY", // Pragma: allowlist secret
          models: [],
        },
      };

      const normalized = normalizeProviders({ agentDir, providers });
      expect(Object.keys(normalized ?? {})).toEqual(["openai"]);
      expect(normalized?.openai?.baseUrl).toBe("https://example.com/v1");
      expect(normalized?.openai?.apiKey).toBe("CUSTOM_OPENAI_API_KEY");
      expect(normalized?.openai?.models?.[0]?.id).toBe("gpt-4.1-mini");
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });
  it("replaces resolved env var value with env var name to prevent plaintext persistence", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test-secret-value-12345", // Pragma: allowlist secret
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const secretRefManagedProviders = new Set<string>();
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-secret-value-12345", // Pragma: allowlist secret; simulates resolved ${OPENAI_API_KEY}
          api: "openai-completions",
          models: [
            {
              contextWindow: 128_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "gpt-4.1",
              input: ["text"],
              maxTokens: 16_384,
              name: "GPT-4.1",
              reasoning: false,
            },
          ],
        },
      };
      const normalized = normalizeProviders({
        agentDir,
        env,
        providers,
        secretRefManagedProviders,
      });
      expect(normalized?.openai?.apiKey).toBe("OPENAI_API_KEY");
      expect(secretRefManagedProviders.has("openai")).toBe(true);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("normalizes SecretRef-managed provider apiKey values to env markers", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const secretRefManagedProviders = new Set<string>();
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        custom: {
          api: "openai-responses",
          apiKey: { id: "CUSTOM_PROVIDER_API_KEY", provider: "default", source: "env" },
          baseUrl: "https://config.example/v1",
          models: [createModel()],
        },
      };

      const normalized = normalizeProviders({
        agentDir,
        providers,
        secretRefManagedProviders,
      });

      expect(normalized?.custom?.apiKey).toBe("CUSTOM_PROVIDER_API_KEY"); // Pragma: allowlist secret
      expect(secretRefManagedProviders.has("custom")).toBe(true);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("reads provider apiKey markers from auth-profiles env refs", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      await fs.writeFile(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            profiles: {
              "minimax:default": {
                keyRef: { id: "MINIMAX_API_KEY", provider: "default", source: "env" },
                provider: "minimax",
                type: "api_key",
              },
            },
            version: 1,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const resolved = resolveApiKeyFromProfiles({
        env: process.env,
        provider: "minimax",
        store: {
          profiles: {
            "minimax:default": {
              keyRef: { id: "MINIMAX_API_KEY", provider: "default", source: "env" },
              provider: "minimax",
              type: "api_key",
            },
          },
          version: 1,
        },
      });

      expect(resolved?.apiKey).toBe("MINIMAX_API_KEY"); // Pragma: allowlist secret
      expect(resolved?.source).toBe("env-ref");
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("normalizes SecretRef-backed provider headers to non-secret marker values", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          headers: {
            Authorization: { id: "OPENAI_HEADER_TOKEN", provider: "default", source: "env" },
            "X-Tenant-Token": { id: "/openai/token", provider: "vault", source: "file" },
          },
          models: [],
        },
      };

      const normalized = normalizeProviders({
        agentDir,
        providers,
      });
      expect(normalized?.openai?.headers?.Authorization).toBe("secretref-env:OPENAI_HEADER_TOKEN");
      expect(normalized?.openai?.headers?.["X-Tenant-Token"]).toBe(NON_ENV_SECRETREF_MARKER);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("ignores non-object provider entries during source-managed enforcement", () => {
    const providers = {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        api: "openai-completions",
        apiKey: "sk-runtime-moonshot", // Pragma: allowlist secret
        models: [],
      },
      openai: null,
    } as unknown as NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

    const sourceProviders: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        api: "openai-completions",
        apiKey: { id: "MOONSHOT_API_KEY", provider: "default", source: "env" }, // Pragma: allowlist secret
        models: [],
      },
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" }, // Pragma: allowlist secret
        models: [],
      },
    };

    const enforced = enforceSourceManagedProviderSecrets({
      providers,
      sourceProviders,
    });
    expect((enforced as Record<string, unknown>).openai).toBeNull();
    expect(enforced?.moonshot?.apiKey).toBe("MOONSHOT_API_KEY"); // Pragma: allowlist secret
  });
});
