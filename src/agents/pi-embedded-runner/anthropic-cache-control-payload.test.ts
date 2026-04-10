import { describe, expect, it } from "vitest";
import { applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-cache-control-payload.js";

describe("applyAnthropicEphemeralCacheControlMarkers", () => {
  it("marks system text content as ephemeral and strips thinking cache markers", () => {
    const payload = {
      messages: [
        { content: "system prompt", role: "system" },
        {
          content: [
            { cache_control: { type: "ephemeral" }, text: "draft", type: "thinking" },
            { text: "answer", type: "text" },
          ],
          role: "assistant",
        },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages).toEqual([
      {
        content: [{ cache_control: { type: "ephemeral" }, text: "system prompt", type: "text" }],
        role: "system",
      },
      {
        content: [
          { text: "draft", type: "thinking" },
          { text: "answer", type: "text" },
        ],
        role: "assistant",
      },
    ]);
  });
});
