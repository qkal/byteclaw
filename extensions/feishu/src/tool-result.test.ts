import { describe, expect, it } from "vitest";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";

describe("jsonToolResult", () => {
  it("formats tool result with text content and details", () => {
    const payload = { id: "abc", ok: true };
    expect(jsonToolResult(payload)).toEqual({
      content: [{ text: JSON.stringify(payload, null, 2), type: "text" }],
      details: payload,
    });
  });

  it("formats unknown action errors", () => {
    expect(unknownToolActionResult("create")).toEqual({
      content: [
        { text: JSON.stringify({ error: "Unknown action: create" }, null, 2), type: "text" },
      ],
      details: { error: "Unknown action: create" },
    });
  });

  it("formats execution errors", () => {
    expect(toolExecutionErrorResult(new Error("boom"))).toEqual({
      content: [{ text: JSON.stringify({ error: "boom" }, null, 2), type: "text" }],
      details: { error: "boom" },
    });
  });
});
