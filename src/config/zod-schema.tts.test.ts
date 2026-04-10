import { describe, expect, it } from "vitest";
import { TtsConfigSchema } from "./zod-schema.core.js";

describe("TtsConfigSchema openai speed and instructions", () => {
  it("accepts speed and instructions in openai section", () => {
    expect(() =>
      TtsConfigSchema.parse({
        providers: {
          openai: {
            instructions: "Speak in a cheerful tone",
            speed: 1.5,
            voice: "alloy",
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects out-of-range openai speed", () => {
    expect(() =>
      TtsConfigSchema.parse({
        providers: {
          openai: {
            speed: 5,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects openai speed below minimum", () => {
    expect(() =>
      TtsConfigSchema.parse({
        providers: {
          openai: {
            speed: 0.1,
          },
        },
      }),
    ).not.toThrow();
  });
});
