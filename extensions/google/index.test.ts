import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import type {
  ProviderReplaySessionEntry,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import { registerGoogleProvider } from "./provider-registration.js";

const googleProviderPlugin = {
  register(api: Parameters<typeof registerGoogleProvider>[0]) {
    registerGoogleProvider(api);
    registerGoogleGeminiCliProvider(api);
  },
};

describe("google provider plugin hooks", () => {
  it("owns replay policy and reasoning mode for the direct Gemini provider", async () => {
    const { providers } = await registerProviderPlugin({
      id: "google",
      name: "Google Provider",
      plugin: googleProviderPlugin,
    });
    const provider = requireRegisteredProvider(providers, "google");
    const customEntries: ProviderReplaySessionEntry[] = [];

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
      } as never),
    ).toEqual({
      allowSyntheticToolResults: true,
      applyAssistantFirstOrderingFix: true,
      repairToolUseResultPairing: true,
      sanitizeMode: "full",
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: false,
      validateGeminiTurns: true,
    });

    expect(
      provider.resolveReasoningOutputMode?.({
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
      } as never),
    ).toBe("tagged");

    const sanitized = await Promise.resolve(
      provider.sanitizeReplayHistory?.({
        messages: [
          {
            content: [{ type: "text", text: "hello" }],
            role: "assistant",
          },
        ],
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionId: "session-1",
        sessionState: {
          appendCustomEntry: (customType: string, data: unknown) => {
            customEntries.push({ customType, data });
          },
          getCustomEntries: () => customEntries,
        },
      } as ProviderSanitizeReplayHistoryContext),
    );

    expect(sanitized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "(session bootstrap)",
          role: "user",
        }),
      ]),
    );
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });

  it("owns Gemini CLI tool schema normalization", async () => {
    const { providers } = await registerProviderPlugin({
      id: "google",
      name: "Google Provider",
      plugin: googleProviderPlugin,
    });
    const provider = requireRegisteredProvider(providers, "google-gemini-cli");

    const [tool] =
      provider.normalizeToolSchemas?.({
        provider: "google-gemini-cli",
        tools: [
          {
            description: "Write a file",
            name: "write_file",
            parameters: {
              additionalProperties: false,
              properties: {
                path: { pattern: "^src/", type: "string" },
              },
              type: "object",
            },
          },
        ],
      } as never) ?? [];

    expect(tool).toMatchObject({
      name: "write_file",
      parameters: {
        properties: {
          path: { type: "string" },
        },
        type: "object",
      },
    });
    expect(tool?.parameters).not.toHaveProperty("additionalProperties");
    expect(
      (tool?.parameters as { properties?: { path?: Record<string, unknown> } })?.properties?.path,
    ).not.toHaveProperty("pattern");
    expect(
      provider.inspectToolSchemas?.({
        provider: "google-gemini-cli",
        tools: [tool],
      } as never),
    ).toEqual([]);
  });

  it("wires google-thinking stream hooks for direct and Gemini CLI providers", async () => {
    const { providers } = await registerProviderPlugin({
      id: "google",
      name: "Google Provider",
      plugin: googleProviderPlugin,
    });
    const googleProvider = requireRegisteredProvider(providers, "google");
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
        string,
        unknown
      >;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };

    const runCase = (provider: typeof googleProvider, providerId: string) => {
      const wrapped = provider.wrapStreamFn?.({
        modelId: "gemini-3.1-pro-preview",
        provider: providerId,
        streamFn: baseStreamFn,
        thinkingLevel: "high",
      } as never);

      void wrapped?.(
        {
          api: "google-generative-ai",
          id: "gemini-3.1-pro-preview",
          provider: providerId,
        } as Model<"google-generative-ai">,
        { messages: [] } as Context,
        {},
      );

      expect(capturedPayload).toMatchObject({
        config: { thinkingConfig: { thinkingLevel: "HIGH" } },
      });
      const thinkingConfig = (
        (capturedPayload as Record<string, unknown>).config as Record<string, unknown>
      ).thinkingConfig as Record<string, unknown>;
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
    };

    runCase(googleProvider, "google");
    runCase(cliProvider, "google-gemini-cli");
  });
});
