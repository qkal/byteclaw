import { describe, expect, it } from "vitest";
import { type ToolPayloadCarrier, extractToolPayload } from "./tool-payload.js";

describe("extractToolPayload", () => {
  it("returns undefined for missing results", () => {
    expect(extractToolPayload(undefined)).toBeUndefined();
    expect(extractToolPayload(null)).toBeUndefined();
  });

  it("prefers explicit details payloads", () => {
    expect(
      extractToolPayload({
        content: [{ text: '{"ignored":true}', type: "text" }],
        details: { ok: true },
      }),
    ).toEqual({ ok: true });
  });

  it("parses JSON text blocks and falls back to raw text, content, or the whole result", () => {
    expect(
      extractToolPayload({
        content: [
          { type: "image", url: "https://example.com/a.png" },
          { text: '{"ok":true,"count":2}', type: "text" },
        ],
      }),
    ).toEqual({ count: 2, ok: true });

    expect(
      extractToolPayload({
        content: [{ text: "not json", type: "text" }],
      }),
    ).toBe("not json");

    const content = [{ type: "image", url: "https://example.com/a.png" }];
    expect(
      extractToolPayload({
        content,
      }),
    ).toBe(content);

    const result = { status: "ok" } as ToolPayloadCarrier & { status: string };
    expect(extractToolPayload(result)).toBe(result);
  });
});
