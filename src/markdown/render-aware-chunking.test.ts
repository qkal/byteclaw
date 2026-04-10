import { describe, expect, it } from "vitest";
import type { MarkdownIR } from "./ir.js";
import { markdownToIR } from "./ir.js";
import { renderMarkdownIRChunksWithinLimit } from "./render-aware-chunking.js";
import { renderMarkdownWithMarkers } from "./render.js";

function renderEscapedHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    escapeText: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    styleMarkers: {
      blockquote: { close: "</blockquote>", open: "<blockquote>" },
      bold: { close: "</b>", open: "<b>" },
      code: { close: "</code>", open: "<code>" },
      code_block: { close: "</code></pre>", open: "<pre><code>" },
      italic: { close: "</i>", open: "<i>" },
      spoiler: { close: "</tg-spoiler>", open: "<tg-spoiler>" },
      strikethrough: { close: "</s>", open: "<s>" },
    },
  });
}

describe("renderMarkdownIRChunksWithinLimit", () => {
  it("prefers word boundaries when escaping shrinks the render budget", () => {
    const ir = markdownToIR("alpha <<");
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 8,
      measureRendered: (rendered) => rendered.length,
      renderChunk: renderEscapedHtml,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["alpha ", "<<"]);
    expect(chunks.map((chunk) => chunk.source.text).join("")).toBe("alpha <<");
    expect(chunks.every((chunk) => chunk.rendered.length <= 8)).toBe(true);
  });

  it("preserves formatting when a rendered chunk is re-split", () => {
    const ir = markdownToIR("**Which of these**", {
      headingStyle: "none",
    });
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 16,
      measureRendered: (rendered) => rendered.length,
      renderChunk: renderEscapedHtml,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["Which of ", "these"]);
    expect(chunks.every((chunk) => chunk.rendered.startsWith("<b>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.rendered.endsWith("</b>"))).toBe(true);
  });

  it("checks exact candidates instead of assuming rendered length is monotonic", () => {
    const ir: MarkdownIR = {
      links: [],
      styles: [],
      text: "README.md<",
    };
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 10,
      measureRendered: (rendered) => rendered.length,
      renderChunk: (chunk) =>
        chunk.text === "README.md"
          ? "fits-here"
          : chunk.text.startsWith("README.md")
            ? "this-rendering-is-too-long"
            : chunk.text,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["README.md", "<"]);
  });
});
