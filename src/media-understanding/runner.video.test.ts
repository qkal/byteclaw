import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runCapability } from "./runner.js";
import { withVideoFixture } from "./runner.test-utils.js";

describe("runCapability video provider wiring", () => {
  it("merges video baseUrl and headers with entry precedence", async () => {
    let seenBaseUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;

    await withTempDir({ prefix: "openclaw-video-auth-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-merge", async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              moonshot: {
                auth: "api-key",
                apiKey: "provider-key", // Pragma: allowlist secret
                baseUrl: "https://provider.example/v1",
                headers: { "X-Provider": "1" },
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                baseUrl: "https://config.example/v1",
                enabled: true,
                headers: { "X-Config": "2" },
                models: [
                  {
                    baseUrl: "https://entry.example/v1",
                    headers: { "X-Entry": "3" },
                    model: "kimi-k2.5",
                    provider: "moonshot",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          agentDir: isolatedAgentDir,
          attachments: cache,
          capability: "video",
          cfg,
          ctx,
          media,
          providerRegistry: new Map([
            [
              "moonshot",
              {
                capabilities: ["video"],
                describeVideo: async (req) => {
                  seenBaseUrl = req.baseUrl;
                  seenHeaders = req.headers;
                  return { text: "video ok", model: req.model };
                },
                id: "moonshot",
              },
            ],
          ]),
        });

        expect(result.outputs[0]?.text).toBe("video ok");
        expect(result.outputs[0]?.provider).toBe("moonshot");
        expect(seenBaseUrl).toBe("https://entry.example/v1");
        expect(seenHeaders).toMatchObject({
          "X-Config": "2",
          "X-Entry": "3",
          "X-Provider": "1",
        });
      });
    });
  });

  it("auto-selects moonshot for video when google is unavailable", async () => {
    await withTempDir({ prefix: "openclaw-video-agent-" }, async (isolatedAgentDir) => {
      await withEnvAsync(
        {
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          MOONSHOT_API_KEY: undefined,
          OPENCLAW_AGENT_DIR: isolatedAgentDir,
          PI_CODING_AGENT_DIR: isolatedAgentDir,
        },
        async () => {
          await withVideoFixture("openclaw-video-auto-moonshot", async ({ ctx, media, cache }) => {
            const cfg = {
              models: {
                providers: {
                  moonshot: {
                    auth: "api-key",
                    apiKey: "moonshot-key", // Pragma: allowlist secret
                    models: [],
                  },
                },
              },
              tools: {
                media: {
                  video: {
                    enabled: true,
                  },
                },
              },
            } as unknown as OpenClawConfig;

            const result = await runCapability({
              agentDir: isolatedAgentDir,
              attachments: cache,
              capability: "video",
              cfg,
              ctx,
              media,
              providerRegistry: new Map([
                [
                  "google",
                  {
                    capabilities: ["video"],
                    describeVideo: async () => ({ text: "google" }),
                    id: "google",
                  },
                ],
                [
                  "moonshot",
                  {
                    capabilities: ["video"],
                    describeVideo: async () => ({ text: "moonshot", model: "kimi-k2.5" }),
                    id: "moonshot",
                  },
                ],
              ]),
            });

            expect(result.decision.outcome).toBe("success");
            expect(result.outputs[0]?.provider).toBe("moonshot");
            expect(result.outputs[0]?.text).toBe("moonshot");
          });
        },
      );
    });
  });
});
