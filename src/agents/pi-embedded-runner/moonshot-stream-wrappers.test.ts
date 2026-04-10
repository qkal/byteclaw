import { describe, expect, it } from "vitest";
import { shouldApplyMoonshotPayloadCompat } from "./moonshot-stream-wrappers.js";

describe("moonshot stream wrappers", () => {
  it("keeps Moonshot compatibility on the lightweight provider-id path", () => {
    expect(
      shouldApplyMoonshotPayloadCompat({
        modelId: "kimi-k2.5",
        provider: "moonshot",
      }),
    ).toBe(true);
    expect(
      shouldApplyMoonshotPayloadCompat({
        modelId: "kimi-code",
        provider: "kimi-coding",
      }),
    ).toBe(true);
    expect(
      shouldApplyMoonshotPayloadCompat({
        modelId: "kimi-k2.5:cloud",
        provider: "ollama",
      }),
    ).toBe(true);
    expect(
      shouldApplyMoonshotPayloadCompat({
        modelId: "gpt-5.4",
        provider: "openai",
      }),
    ).toBe(false);
  });
});
