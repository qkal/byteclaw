import { describe, expect, it } from "vitest";
import { collectPresentOpenClawTools } from "./openclaw-tools.registration.js";
import { type AnyAgentTool, textResult } from "./tools/common.js";

function stubAgentTool(name: string): AnyAgentTool {
  return {
    description: `${name} stub`,
    async execute() {
      return textResult("ok", {});
    },
    label: name,
    name,
    parameters: { properties: {}, type: "object" },
  };
}

describe("openclaw tools image generation registration", () => {
  it("registers image_generate when an image-generation tool is present", () => {
    const imageGenerateTool = stubAgentTool("image_generate");

    expect(collectPresentOpenClawTools([imageGenerateTool])).toEqual([imageGenerateTool]);
  });

  it("omits image_generate when the image-generation tool is absent", () => {
    expect(collectPresentOpenClawTools([null]).map((tool) => tool.name)).not.toContain(
      "image_generate",
    );
  });
});
