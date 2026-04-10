import { describe, expect, it } from "vitest";
import { createUpdatePlanTool } from "./update-plan-tool.js";

describe("update_plan tool", () => {
  it("returns a compact success payload", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      explanation: "Started work",
      plan: [
        { status: "completed", step: "Inspect harness" },
        { status: "in_progress", step: "Add tool" },
        { status: "pending", step: "Run tests" },
      ],
    });

    expect(result.content).toEqual([{ text: "Plan updated.", type: "text" }]);
    expect(result.details).toEqual({
      status: "updated",
    });
  });

  it("rejects multiple in-progress steps", async () => {
    const tool = createUpdatePlanTool();

    await expect(
      tool.execute("call-1", {
        plan: [
          { status: "in_progress", step: "One" },
          { status: "in_progress", step: "Two" },
        ],
      }),
    ).rejects.toThrow("plan can contain at most one in_progress step");
  });
});
