import { describe, expect, it } from "vitest";
import { extractPayloadText } from "./test-helpers.agent-results.js";

describe("extractPayloadText", () => {
  it("returns plain payload text unchanged", () => {
    expect(
      extractPayloadText({
        payloads: [{ text: "hello world" }],
      }),
    ).toBe("hello world");
  });

  it("extracts final text from Claude CLI stream-json payloads", () => {
    const streamJson = [
      JSON.stringify({
        subtype: "init",
        type: "system",
      }),
      JSON.stringify({
        message: {
          content: [{ text: "CLI backend OK ABC123.", type: "text" }],
        },
        type: "assistant",
      }),
      JSON.stringify({
        result: "CLI backend OK ABC123.",
        type: "result",
      }),
    ].join("\n");

    expect(
      extractPayloadText({
        payloads: [{ text: streamJson }],
      }),
    ).toBe("CLI backend OK ABC123.");
  });
});
