import { type Model, completeSimple } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";

const MOONSHOT_KEY = process.env.MOONSHOT_API_KEY ?? "";
const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL?.trim() || "https://api.moonshot.ai/v1";
const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL?.trim() || "kimi-k2.5";
const LIVE = isLiveTestEnabled(["MOONSHOT_LIVE_TEST"]);

const describeLive = LIVE && MOONSHOT_KEY ? describe : describe.skip;

function forceMoonshotInstantMode(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  // Moonshot's official API exposes instant mode via thinking.type=disabled.
  // Without this, tiny smoke probes can spend the full token budget in hidden
  // Reasoning_content and never emit visible assistant text.
  (payload as Record<string, unknown>).thinking = { type: "disabled" };
}

describeLive("moonshot live", () => {
  it("returns assistant text", async () => {
    const model: Model<"openai-completions"> = {
      api: "openai-completions",
      baseUrl: MOONSHOT_BASE_URL,
      contextWindow: 256_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: MOONSHOT_MODEL,
      input: ["text", "image"],
      maxTokens: 8192,
      name: `Moonshot ${MOONSHOT_MODEL}`,
      provider: "moonshot",
      reasoning: false,
    };

    const res = await completeSimple(
      model,
      {
        messages: createSingleUserPromptMessage(),
      },
      {
        apiKey: MOONSHOT_KEY,
        maxTokens: 64,
        onPayload: (payload) => {
          forceMoonshotInstantMode(payload);
        },
      },
    );

    const text = extractNonEmptyAssistantText(res.content);
    expect(text.length).toBeGreaterThan(0);
  }, 30_000);
});
