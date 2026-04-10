import type { MarkdownTableMode } from "../config/types.base.js";
import { markdownToIRWithMeta } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";

const MARKDOWN_STYLE_MARKERS = {
  bold: { close: "**", open: "**" },
  code: { close: "`", open: "`" },
  code_block: { close: "```", open: "```\n" },
  italic: { close: "_", open: "_" },
  strikethrough: { close: "~~", open: "~~" },
} as const;

export function convertMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
  if (!markdown || mode === "off") {
    return markdown;
  }
  const effectiveMode = mode === "block" ? "code" : mode;
  const { ir, hasTables } = markdownToIRWithMeta(markdown, {
    autolink: false,
    blockquotePrefix: "",
    headingStyle: "none",
    linkify: false,
    tableMode: effectiveMode,
  });
  if (!hasTables) {
    return markdown;
  }
  return renderMarkdownWithMarkers(ir, {
    buildLink: (link, text) => {
      const href = link.href.trim();
      if (!href) {
        return null;
      }
      const label = text.slice(link.start, link.end);
      if (!label) {
        return null;
      }
      return { close: `](${href})`, end: link.end, open: "[", start: link.start };
    },
    escapeText: (text) => text,
    styleMarkers: MARKDOWN_STYLE_MARKERS,
  });
}
