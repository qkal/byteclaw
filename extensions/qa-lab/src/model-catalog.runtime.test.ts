import { describe, expect, it } from "vitest";
import { selectQaRunnerModelOptions } from "./model-catalog.runtime.js";

describe("qa runner model catalog", () => {
  it("filters to available rows and prefers gpt-5.4 first", () => {
    expect(
      selectQaRunnerModelOptions([
        {
          available: true,
          input: "text",
          key: "anthropic/claude-sonnet-4-5",
          missing: false,
          name: "Claude Sonnet 4.5",
        },
        {
          available: true,
          input: "text,image",
          key: "openai/gpt-5.4",
          missing: false,
          name: "gpt-5.4",
        },
        {
          available: false,
          input: "text",
          key: "openrouter/auto",
          missing: false,
          name: "OpenRouter Auto",
        },
      ]).map((entry) => entry.key),
    ).toEqual(["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"]);
  });
});
