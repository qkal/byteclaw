import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveFinalAssistantVisibleText } from "./helpers.js";

function makeAssistantMessage(
  content: AssistantMessage["content"],
  phase?: string,
): AssistantMessage {
  return {
    api: "responses",
    content,
    model: "gpt-5.4",
    provider: "openai",
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
    ...(phase ? { phase } : {}),
  };
}

describe("resolveFinalAssistantVisibleText", () => {
  it("prefers final_answer text over commentary blocks", () => {
    const lastAssistant = makeAssistantMessage([
      {
        text: "Working...",
        textSignature: JSON.stringify({ id: "item_commentary", phase: "commentary", v: 1 }),
        type: "text",
      },
      {
        text: "Section 1\nSection 2",
        textSignature: JSON.stringify({ id: "item_final", phase: "final_answer", v: 1 }),
        type: "text",
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBe("Section 1\nSection 2");
  });

  it("returns undefined when the final visible text is empty", () => {
    const lastAssistant = makeAssistantMessage([
      {
        text: "Working...",
        textSignature: JSON.stringify({ id: "item_commentary", phase: "commentary", v: 1 }),
        type: "text",
      },
      {
        text: "   ",
        textSignature: JSON.stringify({ id: "item_final", phase: "final_answer", v: 1 }),
        type: "text",
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBeUndefined();
  });
});
