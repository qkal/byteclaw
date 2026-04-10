/**
 * Colored text support for Feishu documents.
 *
 * Parses a simple color markup syntax and updates a text block
 * with native Feishu text_run color styles.
 *
 * Syntax: [color]text[/color]
 * Supported colors: red, orange, yellow, green, blue, purple, grey
 *
 * Example:
 *   "Revenue [green]+15%[/green] YoY, Costs [red]-3%[/red]"
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

// Feishu text_color values (1-7)
const TEXT_COLOR: Record<string, number> = {
  red: 1, // Pink (closest to red in Feishu)
  orange: 2,
  yellow: 3,
  green: 4,
  blue: 5,
  purple: 6,
  grey: 7,
  gray: 7,
};

// Feishu background_color values (1-15)
const BACKGROUND_COLOR: Record<string, number> = {
  blue: 5,
  gray: 7,
  green: 4,
  grey: 7,
  orange: 2,
  purple: 6,
  red: 1,
  yellow: 3,
};

interface Segment {
  text: string;
  textColor?: number;
  bgColor?: number;
  bold?: boolean;
}

type DocxPatchPayload = NonNullable<Parameters<Lark.Client["docx"]["documentBlock"]["patch"]>[0]>;
type DocxTextElement = NonNullable<
  NonNullable<NonNullable<DocxPatchPayload["data"]>["update_text_elements"]>["elements"]
>[number];

/**
 * Parse color markup into segments.
 *
 * Supports:
 *   [red]text[/red]               → red text
 *   [bg:yellow]text[/bg]          → yellow background
 *   [bold]text[/bold]             → bold
 *   [green bold]text[/green]      → green + bold
 */
export function parseColorMarkup(content: string): Segment[] {
  const segments: Segment[] = [];
  // Only [known_tag]...[/...] pairs are treated as markup.  Using an open
  // Pattern like \[([^\]]+)\] would match any bracket token — e.g. [Q1] —
  // And cause it to consume a later real closing tag ([/red]), silently
  // Corrupting the surrounding styled spans.  Restricting the opening tag to
  // The set of recognised colour/style names prevents that: [Q1] does not
  // Match the tag alternative and each of its characters falls through to the
  // Plain-text alternatives instead.
  //
  // Closing tag name is still not validated against the opening tag:
  // [red]text[/green] is treated as [red]text[/red] — opening style applies
  // And the closing tag is consumed regardless of its name.
  const KNOWN = "(?:bg:[a-z]+|bold|red|orange|yellow|green|blue|purple|gr[ae]y)";
  const tagPattern = new RegExp(
    `\\[(${KNOWN}(?:\\s+${KNOWN})*)\\](.*?)\\[\\/(?:[^\\]]+)\\]|([^[]+|\\[)`,
    "gis",
  );
  let match;

  while ((match = tagPattern.exec(content)) !== null) {
    if (match[3] !== undefined) {
      // Plain text segment
      if (match[3]) {
        segments.push({ text: match[3] });
      }
    } else {
      // Tagged segment
      const tagStr = normalizeLowercaseStringOrEmpty(match[1]);
      const text = match[2];
      const tags = tagStr.split(/\s+/);

      const segment: Segment = { text };

      for (const tag of tags) {
        if (tag.startsWith("bg:")) {
          const color = tag.slice(3);
          if (BACKGROUND_COLOR[color]) {
            segment.bgColor = BACKGROUND_COLOR[color];
          }
        } else if (tag === "bold") {
          segment.bold = true;
        } else if (TEXT_COLOR[tag]) {
          segment.textColor = TEXT_COLOR[tag];
        }
      }

      if (text) {
        segments.push(segment);
      }
    }
  }

  return segments;
}

/**
 * Update a text block with colored segments.
 */
export async function updateColorText(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  content: string,
) {
  const segments = parseColorMarkup(content);

  const elements: DocxTextElement[] = segments.map((seg) => ({
    text_run: {
      content: seg.text,
      text_element_style: {
        ...(seg.textColor && { text_color: seg.textColor }),
        ...(seg.bgColor && { background_color: seg.bgColor }),
        ...(seg.bold && { bold: true }),
      },
    },
  }));

  const res = await client.docx.documentBlock.patch({
    data: { update_text_elements: { elements } },
    path: { block_id: blockId, document_id: docToken },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    block: res.data?.block,
    segments: segments.length,
    success: true,
  };
}
