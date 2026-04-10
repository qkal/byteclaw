import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { makeZeroUsageSnapshot } from "./usage.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["GEMINI_LIVE_TEST"]);

const describeLive = LIVE && GEMINI_KEY ? describe : describe.skip;

describeLive("gemini live switch", () => {
  const googleModels = ["gemini-3-pro-preview", "gemini-2.5-pro"] as const;

  for (const modelId of googleModels) {
    it(`handles unsigned tool calls from Antigravity when switching to ${modelId}`, async () => {
      const now = Date.now();
      const model = getModel("google", modelId);

      const res = await completeSimple(
        model,
        {
          messages: [
            {
              content: "Reply with ok.",
              role: "user",
              timestamp: now,
            },
            {
              api: "google-gemini-cli",
              content: [
                {
                  arguments: { command: "ls -la" },
                  id: "call_1",
                  name: "bash",
                  type: "toolCall",
                  // No thoughtSignature: simulates Claude via Antigravity.
                },
              ],
              model: "claude-sonnet-4-20250514",
              provider: "google-antigravity",
              role: "assistant",
              stopReason: "stop",
              timestamp: now,
              usage: makeZeroUsageSnapshot(),
            },
          ],
          tools: [
            {
              description: "Run shell command",
              name: "bash",
              parameters: Type.Object({
                command: Type.String(),
              }),
            },
          ],
        },
        {
          apiKey: GEMINI_KEY,
          maxTokens: 128,
          reasoning: "low",
        },
      );

      expect(res.stopReason).not.toBe("error");
    }, 20_000);
  }
});
