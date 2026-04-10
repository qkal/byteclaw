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

describe("openclaw tools video generation registration", () => {
  it("registers video_generate when a video-generation tool is present", () => {
    const videoGenerateTool = stubAgentTool("video_generate");

    expect(collectPresentOpenClawTools([videoGenerateTool])).toEqual([videoGenerateTool]);
  });

  it("omits video_generate when the video-generation tool is absent", () => {
    expect(collectPresentOpenClawTools([null]).map((tool) => tool.name)).not.toContain(
      "video_generate",
    );
  });
});
