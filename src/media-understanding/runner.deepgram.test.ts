import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

const modelAuthMocks = vi.hoisted(() => ({
  hasAvailableAuthForProvider: vi.fn(() => true),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    mode: "api-key",
    source: "test",
  })),
}));

vi.mock("../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: modelAuthMocks.hasAvailableAuthForProvider,
  requireApiKey: modelAuthMocks.requireApiKey,
  resolveApiKeyForProvider: modelAuthMocks.resolveApiKeyForProvider,
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

describe("runCapability deepgram provider options", () => {
  it("merges provider options, headers, and baseUrl overrides", async () => {
    await withAudioFixture("openclaw-deepgram", async ({ ctx, media, cache }) => {
      let seenQuery: Record<string, string | number | boolean> | undefined;
      let seenBaseUrl: string | undefined;
      let seenHeaders: Record<string, string> | undefined;
      let seenRequest:
        | import("../agents/provider-request-config.js").ProviderRequestTransportOverrides
        | undefined;

      const providerRegistry = buildProviderRegistry({
        deepgram: {
          capabilities: ["audio"],
          id: "deepgram",
          transcribeAudio: async (req) => {
            seenQuery = req.query;
            seenBaseUrl = req.baseUrl;
            seenHeaders = req.headers;
            seenRequest = req.request;
            return { model: req.model, text: "ok" };
          },
        },
      });

      const cfg = {
        models: {
          providers: {
            deepgram: {
              apiKey: "test-key",
              baseUrl: "https://provider.example",
              headers: {
                "X-Provider": "1",
                "X-Provider-Managed": "secretref-managed",
              },
              models: [],
            },
          },
        },
        tools: {
          media: {
            audio: {
              baseUrl: "https://config.example",
              deepgram: { smartFormat: true },
              enabled: true,
              headers: {
                "X-Config": "2",
                "X-Config-Managed": "secretref-env:DEEPGRAM_HEADER_TOKEN",
              },
              models: [
                {
                  baseUrl: "https://entry.example",
                  headers: {
                    "X-Entry": "3",
                    "X-Entry-Managed": "secretref-managed",
                  },
                  model: "nova-3",
                  provider: "deepgram",
                  providerOptions: {
                    deepgram: {
                      detectLanguage: false,
                      punctuate: false,
                      smart_format: true,
                    },
                  },
                  request: {
                    headers: {
                      "X-Entry-Request": "entry",
                    },
                    tls: {
                      serverName: "deepgram.internal",
                    },
                  },
                },
              ],
              providerOptions: {
                deepgram: {
                  detect_language: true,
                  punctuate: true,
                },
              },
              request: {
                auth: {
                  headerName: "x-config-auth",
                  mode: "header",
                  value: "cfg-secret",
                },
                headers: {
                  "X-Config-Request": "cfg",
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = await runCapability({
        attachments: cache,
        capability: "audio",
        cfg,
        ctx,
        media,
        providerRegistry,
      });
      expect(result.outputs[0]?.text).toBe("ok");
      expect(seenBaseUrl).toBe("https://entry.example");
      expect(seenHeaders).toMatchObject({
        "X-Config": "2",
        "X-Config-Managed": "secretref-env:DEEPGRAM_HEADER_TOKEN",
        "X-Entry": "3",
        "X-Entry-Managed": "secretref-managed",
        "X-Provider": "1",
        "X-Provider-Managed": "secretref-managed",
      });
      expect(seenQuery).toMatchObject({
        detect_language: false,
        punctuate: false,
        smart_format: true,
      });
      expect((seenQuery as Record<string, unknown>)["detectLanguage"]).toBeUndefined();
      expect(seenRequest).toEqual({
        auth: {
          headerName: "x-config-auth",
          mode: "header",
          value: "cfg-secret",
        },
        headers: {
          "X-Config-Request": "cfg",
          "X-Entry-Request": "entry",
        },
        tls: {
          serverName: "deepgram.internal",
        },
      });
    });
  });
});
