import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { buildPluginApi } from "../../src/plugins/api-builder.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import amazonBedrockPlugin from "./index.js";

type RegisteredProviderPlugin = Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

/** Register the amazon-bedrock plugin with an optional pluginConfig override. */
async function registerWithConfig(
  pluginConfig?: Record<string, unknown>,
): Promise<RegisteredProviderPlugin> {
  const providers: RegisteredProviderPlugin[] = [];
  const noopLogger = { debug() {}, error() {}, info() {}, warn() {} };
  const api = buildPluginApi({
    config: {} as OpenClawConfig,
    handlers: {
      registerProvider(provider: RegisteredProviderPlugin) {
        providers.push(provider);
      },
    },
    id: "amazon-bedrock",
    logger: noopLogger,
    name: "Amazon Bedrock Provider",
    pluginConfig,
    registrationMode: "full",
    resolvePath: (input) => input,
    runtime: {} as PluginRuntime,
    source: "test",
  });
  await amazonBedrockPlugin.register(api);
  const provider = providers[0];
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}

/** Spy streamFn that returns the options it receives. */
const spyStreamFn = (_model: unknown, _context: unknown, options: Record<string, unknown>) =>
  options;

const ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6-v1";
const NON_ANTHROPIC_MODEL = "amazon.nova-micro-v1:0";

const MODEL_DESCRIPTOR = {
  api: "openai-completions",
  id: NON_ANTHROPIC_MODEL,
  provider: "amazon-bedrock",
} as never;

const ANTHROPIC_MODEL_DESCRIPTOR = {
  api: "openai-completions",
  id: ANTHROPIC_MODEL,
  provider: "amazon-bedrock",
} as never;

/**
 * Call wrapStreamFn and then invoke the returned stream function, capturing
 * the payload via the onPayload hook that streamWithPayloadPatch installs.
 */
function callWrappedStream(
  provider: RegisteredProviderPlugin,
  modelId: string,
  modelDescriptor: never,
): Record<string, unknown> {
  const wrapped = provider.wrapStreamFn?.({
    modelId,
    provider: "amazon-bedrock",
    streamFn: spyStreamFn,
  } as never);

  // The wrapped stream returns the options object (from spyStreamFn).
  // For guardrail-wrapped streams, streamWithPayloadPatch intercepts onPayload,
  // So we need to invoke onPayload on the returned options to trigger the patch.
  const result = wrapped?.(modelDescriptor, { messages: [] } as never, {}) as unknown as Record<
    string,
    unknown
  >;

  // If onPayload was installed by streamWithPayloadPatch, call it to apply the patch.
  if (typeof result?.onPayload === "function") {
    const payload: Record<string, unknown> = {};
    (result.onPayload as (p: Record<string, unknown>) => void)(payload);
    return { ...result, _capturedPayload: payload };
  }

  return result;
}

describe("amazon-bedrock provider plugin", () => {
  it("marks Claude 4.6 Bedrock models as adaptive by default", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(
      provider.resolveDefaultThinkingLevel?.({
        modelId: "us.anthropic.claude-opus-4-6-v1",
        provider: "amazon-bedrock",
      } as never),
    ).toBe("adaptive");
    expect(
      provider.resolveDefaultThinkingLevel?.({
        modelId: "amazon.nova-micro-v1:0",
        provider: "amazon-bedrock",
      } as never),
    ).toBeUndefined();
  });

  it("owns Anthropic-style replay policy for Claude Bedrock models", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "bedrock-converse-stream",
        modelId: ANTHROPIC_MODEL,
        provider: "amazon-bedrock",
      } as never),
    ).toEqual({
      allowSyntheticToolResults: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
    });
  });

  it("disables prompt caching for non-Anthropic Bedrock models", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      modelId: "amazon.nova-micro-v1:0",
      provider: "amazon-bedrock",
      streamFn: (_model: unknown, _context: unknown, options: Record<string, unknown>) => options,
    } as never);

    expect(
      wrapped?.(
        {
          api: "openai-completions",
          id: "amazon.nova-micro-v1:0",
          provider: "amazon-bedrock",
        } as never,
        { messages: [] } as never,
        {},
      ),
    ).toMatchObject({
      cacheRetention: "none",
    });
  });

  describe("guardrail config schema", () => {
    it("defines discovery and guardrail objects with the expected shape", () => {
      const pluginJson = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf8"),
      );
      const discovery = pluginJson.configSchema?.properties?.discovery;
      const guardrail = pluginJson.configSchema?.properties?.guardrail;

      expect(discovery).toBeDefined();
      expect(discovery.type).toBe("object");
      expect(discovery.additionalProperties).toBe(false);
      expect(discovery.properties.enabled).toEqual({ type: "boolean" });
      expect(discovery.properties.region).toEqual({ type: "string" });
      expect(discovery.properties.providerFilter).toEqual({
        items: { type: "string" },
        type: "array",
      });
      expect(discovery.properties.refreshInterval).toEqual({
        minimum: 0,
        type: "integer",
      });
      expect(discovery.properties.defaultContextWindow).toEqual({
        minimum: 1,
        type: "integer",
      });
      expect(discovery.properties.defaultMaxTokens).toEqual({
        minimum: 1,
        type: "integer",
      });

      expect(guardrail).toBeDefined();
      expect(guardrail.type).toBe("object");
      expect(guardrail.additionalProperties).toBe(false);

      // Required fields
      expect(guardrail.required).toEqual(["guardrailIdentifier", "guardrailVersion"]);

      // Property types
      expect(guardrail.properties.guardrailIdentifier).toEqual({ type: "string" });
      expect(guardrail.properties.guardrailVersion).toEqual({ type: "string" });

      // Enum constraints
      expect(guardrail.properties.streamProcessingMode).toEqual({
        enum: ["sync", "async"],
        type: "string",
      });
      expect(guardrail.properties.trace).toEqual({
        enum: ["enabled", "disabled", "enabled_full"],
        type: "string",
      });
    });
  });

  describe("guardrail payload injection", () => {
    it("does not inject guardrailConfig when guardrail is absent from plugin config", async () => {
      const provider = await registerWithConfig(undefined);
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result).not.toHaveProperty("_capturedPayload");
      // The onPayload hook should not exist when no guardrail is configured
      expect(result).toMatchObject({ cacheRetention: "none" });
    });

    it("injects all four fields when guardrail config includes optional fields", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "my-guardrail-id",
          guardrailVersion: "1",
          streamProcessingMode: "sync",
          trace: "enabled",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "my-guardrail-id",
          guardrailVersion: "1",
          streamProcessingMode: "sync",
          trace: "enabled",
        },
      });
    });

    it("injects only required fields when optional fields are omitted", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "abc123",
          guardrailVersion: "DRAFT",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "abc123",
          guardrailVersion: "DRAFT",
        },
      });
    });

    it("injects guardrailConfig for Anthropic models without cacheRetention: none", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
      });
      const result = callWrappedStream(provider, ANTHROPIC_MODEL, ANTHROPIC_MODEL_DESCRIPTOR);

      // Anthropic models should get guardrailConfig
      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
      });
      // Anthropic models should NOT get cacheRetention: "none"
      expect(result).not.toHaveProperty("cacheRetention", "none");
    });

    it("injects guardrailConfig for non-Anthropic models with cacheRetention: none", async () => {
      const provider = await registerWithConfig({
        guardrail: {
          guardrailIdentifier: "guardrail-nova",
          guardrailVersion: "3",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      // Non-Anthropic models should get guardrailConfig
      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "guardrail-nova",
          guardrailVersion: "3",
        },
      });
      // Non-Anthropic models should also get cacheRetention: "none"
      expect(result).toMatchObject({ cacheRetention: "none" });
    });
  });
});
