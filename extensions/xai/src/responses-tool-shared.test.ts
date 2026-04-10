import { describe, expect, it } from "vitest";
import { __testing } from "./responses-tool-shared.js";

describe("xai responses tool helpers", () => {
  it("builds the shared xAI Responses tool body", () => {
    expect(
      __testing.buildXaiResponsesToolBody({
        inputText: "search for openclaw",
        maxTurns: 2,
        model: "grok-4-1-fast",
        tools: [{ type: "x_search" }],
      }),
    ).toEqual({
      input: [{ content: "search for openclaw", role: "user" }],
      max_turns: 2,
      model: "grok-4-1-fast",
      tools: [{ type: "x_search" }],
    });
  });

  it("falls back to annotation citations when the API omits top-level citations", () => {
    expect(
      __testing.resolveXaiResponseTextAndCitations({
        output: [
          {
            content: [
              {
                annotations: [{ type: "url_citation", url: "https://example.com/a" }],
                text: "Found it",
                type: "output_text",
              },
            ],
            type: "message",
          },
        ],
      }),
    ).toEqual({
      citations: ["https://example.com/a"],
      content: "Found it",
    });
  });

  it("prefers explicit top-level citations when present", () => {
    expect(
      __testing.resolveXaiResponseTextAndCitations({
        citations: ["https://example.com/b"],
        output_text: "Done",
      }),
    ).toEqual({
      citations: ["https://example.com/b"],
      content: "Done",
    });
  });

  it("includes inline citations only when enabled", () => {
    const data = {
      citations: ["https://example.com/b"],
      inline_citations: [{ end_index: 4, start_index: 0, url: "https://example.com/b" }],
      output_text: "Done",
    };
    expect(__testing.resolveXaiResponseTextCitationsAndInline(data, true)).toEqual({
      citations: ["https://example.com/b"],
      content: "Done",
      inlineCitations: [{ end_index: 4, start_index: 0, url: "https://example.com/b" }],
    });
    expect(__testing.resolveXaiResponseTextCitationsAndInline(data, false)).toEqual({
      citations: ["https://example.com/b"],
      content: "Done",
      inlineCitations: undefined,
    });
  });
});
