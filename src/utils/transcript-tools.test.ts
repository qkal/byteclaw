import { describe, expect, it } from "vitest";
import { countToolResults, extractToolCallNames, hasToolCall } from "./transcript-tools.js";

describe("transcript-tools", () => {
  describe("extractToolCallNames", () => {
    it("extracts tool name from message.toolName/tool_name", () => {
      expect(extractToolCallNames({ toolName: " weather " })).toEqual(["weather"]);
      expect(extractToolCallNames({ tool_name: "notes" })).toEqual(["notes"]);
    });

    it("extracts tool call names from content blocks (tool_use/toolcall/tool_call)", () => {
      const names = extractToolCallNames({
        content: [
          { text: "hi", type: "text" },
          { name: "read", type: "tool_use" },
          { name: "exec", type: "toolcall" },
          { name: "write", type: "tool_call" },
        ],
      });
      expect(new Set(names)).toEqual(new Set(["read", "exec", "write"]));
    });

    it("normalizes type and trims names; de-dupes", () => {
      const names = extractToolCallNames({
        content: [
          { name: "  read ", type: " TOOL_CALL " },
          { name: "read", type: "tool_call" },
          { name: "", type: "tool_call" },
        ],
        toolName: "read",
      });
      expect(names).toEqual(["read"]);
    });
  });

  describe("hasToolCall", () => {
    it("returns true when tool call names exist", () => {
      expect(hasToolCall({ toolName: "weather" })).toBe(true);
      expect(hasToolCall({ content: [{ name: "read", type: "tool_use" }] })).toBe(true);
    });

    it("returns false when no tool calls exist", () => {
      expect(hasToolCall({})).toBe(false);
      expect(hasToolCall({ content: [{ text: "hi", type: "text" }] })).toBe(false);
    });
  });

  describe("countToolResults", () => {
    it("counts tool_result blocks and tool_result_error blocks; tracks errors via is_error", () => {
      expect(
        countToolResults({
          content: [
            { type: "tool_result" },
            { is_error: true, type: "tool_result" },
            { type: "tool_result_error" },
            { text: "ignore", type: "text" },
          ],
        }),
      ).toEqual({ errors: 1, total: 3 });
    });

    it("handles non-array content", () => {
      expect(countToolResults({ content: "nope" })).toEqual({ errors: 0, total: 0 });
    });
  });
});
