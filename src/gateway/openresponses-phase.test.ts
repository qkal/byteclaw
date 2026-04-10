import { describe, expect, it } from "vitest";
import { CreateResponseBodySchema, OutputItemSchema } from "./open-responses.schema.js";
import { buildAgentPrompt } from "./openresponses-prompt.js";
import { createAssistantOutputItem } from "./openresponses-shape.js";

describe("openresponses phase support", () => {
  it("accepts assistant message phase and rejects user phase", () => {
    const assistantPhaseRequest = CreateResponseBodySchema.safeParse({
      input: [
        {
          content: "Checking logs before I answer.",
          phase: "commentary",
          role: "assistant",
          type: "message",
        },
        {
          content: "What did you find?",
          role: "user",
          type: "message",
        },
      ],
      model: "gpt-5.4",
    });
    expect(assistantPhaseRequest.success).toBe(true);

    const userPhaseRequest = CreateResponseBodySchema.safeParse({
      input: [
        {
          content: "Hi",
          phase: "commentary",
          role: "user",
          type: "message",
        },
      ],
      model: "gpt-5.4",
    });
    expect(userPhaseRequest.success).toBe(false);
  });

  it("accepts assistant output item phase metadata", () => {
    const outputItem = OutputItemSchema.safeParse({
      content: [{ text: "Done.", type: "output_text" }],
      id: "msg_123",
      phase: "final_answer",
      role: "assistant",
      status: "completed",
      type: "message",
    });

    expect(outputItem.success).toBe(true);
  });

  it("shapes assistant output items with the provided phase", () => {
    expect(
      createAssistantOutputItem({
        id: "msg_commentary",
        phase: "commentary",
        status: "completed",
        text: "Checking logs.",
      }),
    ).toMatchObject({
      id: "msg_commentary",
      phase: "commentary",
      role: "assistant",
      status: "completed",
      type: "message",
    });

    expect(
      createAssistantOutputItem({
        id: "msg_final",
        phase: "final_answer",
        status: "completed",
        text: "Root cause found.",
      }),
    ).toMatchObject({
      id: "msg_final",
      phase: "final_answer",
      role: "assistant",
      status: "completed",
      type: "message",
    });
  });

  it("builds prompts from phased assistant history without dropping text", () => {
    const prompt = buildAgentPrompt([
      {
        content: "Checking logs before I answer.",
        phase: "commentary",
        role: "assistant",
        type: "message",
      },
      {
        content: "What did you find?",
        role: "user",
        type: "message",
      },
    ]);

    expect(prompt.message).toContain("Checking logs before I answer.");
    expect(prompt.message).toContain("What did you find?");
  });
});
