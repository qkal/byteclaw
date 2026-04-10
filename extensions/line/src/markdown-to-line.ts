import type { messagingApi } from "@line/bot-sdk";
import { stripMarkdown } from "openclaw/plugin-sdk/text-runtime";
import { type FlexBubble, createReceiptCard, toFlexMessage } from "./flex-templates.js";
export { stripMarkdown } from "openclaw/plugin-sdk/text-runtime";

type FlexMessage = messagingApi.FlexMessage;
type FlexComponent = messagingApi.FlexComponent;
type FlexText = messagingApi.FlexText;
type FlexBox = messagingApi.FlexBox;

export interface ProcessedLineMessage {
  /** The processed text with markdown stripped */
  text: string;
  /** Flex messages extracted from tables/code blocks */
  flexMessages: FlexMessage[];
}

/**
 * Regex patterns for markdown detection
 */
const MARKDOWN_TABLE_REGEX = /^\|(.+)\|[\r\n]+\|[-:\s|]+\|[\r\n]+((?:\|.+\|[\r\n]*)+)/gm;
const MARKDOWN_CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Detect and extract markdown tables from text
 */
export function extractMarkdownTables(text: string): {
  tables: MarkdownTable[];
  textWithoutTables: string;
} {
  const tables: MarkdownTable[] = [];
  let textWithoutTables = text;

  // Reset regex state
  MARKDOWN_TABLE_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  const matches: { fullMatch: string; table: MarkdownTable }[] = [];

  while ((match = MARKDOWN_TABLE_REGEX.exec(text)) !== null) {
    const fullMatch = match[0];
    const headerLine = match[1];
    const bodyLines = match[2];

    const headers = parseTableRow(headerLine);
    const rows = bodyLines
      .trim()
      .split(/[\r\n]+/)
      .filter((line) => line.trim())
      .map(parseTableRow);

    if (headers.length > 0 && rows.length > 0) {
      matches.push({
        fullMatch,
        table: { headers, rows },
      });
    }
  }

  // Remove tables from text in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, table } = matches[i];
    tables.unshift(table);
    textWithoutTables = textWithoutTables.replace(fullMatch, "");
  }

  return { tables, textWithoutTables };
}

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/**
 * Parse a single table row (pipe-separated values)
 */
function parseTableRow(row: string): string[] {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, arr) => {
      // Filter out empty cells at start/end (from leading/trailing pipes)
      if (index === 0 && cell === "") {
        return false;
      }
      if (index === arr.length - 1 && cell === "") {
        return false;
      }
      return true;
    });
}

/**
 * Convert a markdown table to a LINE Flex Message bubble
 */
export function convertTableToFlexBubble(table: MarkdownTable): FlexBubble {
  const parseCell = (
    value: string | undefined,
  ): { text: string; bold: boolean; hasMarkup: boolean } => {
    const raw = value?.trim() ?? "";
    if (!raw) {
      return { bold: false, hasMarkup: false, text: "-" };
    }

    let hasMarkup = false;
    const stripped = raw.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
      hasMarkup = true;
      return String(inner);
    });
    const text = stripped.trim() || "-";
    const bold = /^\*\*.+\*\*$/.test(raw);

    return { bold, hasMarkup, text };
  };

  const headerCells = table.headers.map((header) => parseCell(header));
  const rowCells = table.rows.map((row) => row.map((cell) => parseCell(cell)));
  const hasInlineMarkup =
    headerCells.some((cell) => cell.hasMarkup) ||
    rowCells.some((row) => row.some((cell) => cell.hasMarkup));

  // For simple 2-column tables, use receipt card format
  if (table.headers.length === 2 && !hasInlineMarkup) {
    const items = rowCells.map((row) => ({
      name: row[0]?.text ?? "-",
      value: row[1]?.text ?? "-",
    }));

    return createReceiptCard({
      items,
      title: headerCells.map((cell) => cell.text).join(" / "),
    });
  }

  // For multi-column tables, create a custom layout
  const headerRow: FlexComponent = {
    contents: headerCells.map((cell) => ({
      color: "#333333",
      flex: 1,
      size: "sm",
      text: cell.text,
      type: "text",
      weight: "bold",
      wrap: true,
    })) as FlexText[],
    layout: "horizontal",
    paddingBottom: "sm",
    type: "box",
  } as FlexBox;

  const dataRows: FlexComponent[] = rowCells.slice(0, 10).map((row, rowIndex) => {
    const rowContents = table.headers.map((_, colIndex) => {
      const cell = row[colIndex] ?? { bold: false, hasMarkup: false, text: "-" };
      return {
        color: "#666666",
        flex: 1,
        size: "sm",
        text: cell.text,
        type: "text",
        weight: cell.bold ? "bold" : undefined,
        wrap: true,
      };
    }) as FlexText[];

    return {
      contents: rowContents,
      layout: "horizontal",
      margin: rowIndex === 0 ? "md" : "sm",
      type: "box",
    } as FlexBox;
  });

  return {
    body: {
      contents: [headerRow, { margin: "sm", type: "separator" }, ...dataRows],
      layout: "vertical",
      paddingAll: "lg",
      type: "box",
    },
    type: "bubble",
  };
}

/**
 * Detect and extract code blocks from text
 */
export function extractCodeBlocks(text: string): {
  codeBlocks: CodeBlock[];
  textWithoutCode: string;
} {
  const codeBlocks: CodeBlock[] = [];
  let textWithoutCode = text;

  // Reset regex state
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  const matches: { fullMatch: string; block: CodeBlock }[] = [];

  while ((match = MARKDOWN_CODE_BLOCK_REGEX.exec(text)) !== null) {
    const fullMatch = match[0];
    const language = match[1] || undefined;
    const code = match[2];

    matches.push({
      block: { code: code.trim(), language },
      fullMatch,
    });
  }

  // Remove code blocks in reverse order
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, block } = matches[i];
    codeBlocks.unshift(block);
    textWithoutCode = textWithoutCode.replace(fullMatch, "");
  }

  return { codeBlocks, textWithoutCode };
}

export interface CodeBlock {
  language?: string;
  code: string;
}

/**
 * Convert a code block to a LINE Flex Message bubble
 */
export function convertCodeBlockToFlexBubble(block: CodeBlock): FlexBubble {
  const titleText = block.language ? `Code (${block.language})` : "Code";

  // Truncate very long code to fit LINE's limits
  const displayCode = block.code.length > 2000 ? block.code.slice(0, 2000) + "\n..." : block.code;

  return {
    body: {
      contents: [
        {
          color: "#666666",
          size: "sm",
          text: titleText,
          type: "text",
          weight: "bold",
        } as FlexText,
        {
          backgroundColor: "#F5F5F5",
          contents: [
            {
              type: "text",
              text: displayCode,
              size: "xs",
              color: "#333333",
              wrap: true,
            } as FlexText,
          ],
          cornerRadius: "md",
          layout: "vertical",
          margin: "sm",
          paddingAll: "md",
          type: "box",
        } as FlexBox,
      ],
      layout: "vertical",
      paddingAll: "lg",
      type: "box",
    },
    type: "bubble",
  };
}

/**
 * Extract markdown links from text
 */
export function extractLinks(text: string): { links: MarkdownLink[]; textWithLinks: string } {
  const links: MarkdownLink[] = [];

  // Reset regex state
  MARKDOWN_LINK_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK_REGEX.exec(text)) !== null) {
    links.push({
      text: match[1],
      url: match[2],
    });
  }

  // Replace markdown links with just the text (for plain text output)
  const textWithLinks = text.replace(MARKDOWN_LINK_REGEX, "$1");

  return { links, textWithLinks };
}

export interface MarkdownLink {
  text: string;
  url: string;
}

/**
 * Create a Flex Message with tappable link buttons
 */
export function convertLinksToFlexBubble(links: MarkdownLink[]): FlexBubble {
  const buttons: FlexComponent[] = links.slice(0, 4).map((link, index) => ({
    action: {
      type: "uri",
      label: link.text.slice(0, 20), // LINE button label limit
      uri: link.url,
    },
    margin: index > 0 ? "sm" : undefined,
    style: index === 0 ? "primary" : "secondary",
    type: "button",
  }));

  return {
    body: {
      contents: [
        {
          color: "#333333",
          size: "md",
          text: "Links",
          type: "text",
          weight: "bold",
        } as FlexText,
      ],
      layout: "vertical",
      paddingAll: "lg",
      paddingBottom: "sm",
      type: "box",
    },
    footer: {
      contents: buttons,
      layout: "vertical",
      paddingAll: "md",
      type: "box",
    },
    type: "bubble",
  };
}

/**
 * Main function: Process text for LINE output
 * - Extracts tables → Flex Messages
 * - Extracts code blocks → Flex Messages
 * - Strips remaining markdown
 * - Returns processed text + Flex Messages
 */
export function processLineMessage(text: string): ProcessedLineMessage {
  const flexMessages: FlexMessage[] = [];
  let processedText = text;

  // 1. Extract and convert tables
  const { tables, textWithoutTables } = extractMarkdownTables(processedText);
  processedText = textWithoutTables;

  for (const table of tables) {
    const bubble = convertTableToFlexBubble(table);
    flexMessages.push(toFlexMessage("Table", bubble));
  }

  // 2. Extract and convert code blocks
  const { codeBlocks, textWithoutCode } = extractCodeBlocks(processedText);
  processedText = textWithoutCode;

  for (const block of codeBlocks) {
    const bubble = convertCodeBlockToFlexBubble(block);
    flexMessages.push(toFlexMessage("Code", bubble));
  }

  // 3. Handle links - convert [text](url) to plain text for display
  // (We could also create link buttons, but that can get noisy)
  const { textWithLinks } = extractLinks(processedText);
  processedText = textWithLinks;

  // 4. Strip remaining markdown formatting
  processedText = stripMarkdown(processedText);

  return {
    flexMessages,
    text: processedText,
  };
}

/**
 * Check if text contains markdown that needs conversion
 */
export function hasMarkdownToConvert(text: string): boolean {
  // Check for tables
  MARKDOWN_TABLE_REGEX.lastIndex = 0;
  if (MARKDOWN_TABLE_REGEX.test(text)) {
    return true;
  }

  // Check for code blocks
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;
  if (MARKDOWN_CODE_BLOCK_REGEX.test(text)) {
    return true;
  }

  // Check for other markdown patterns
  if (/\*\*[^*]+\*\*/.test(text)) {
    return true;
  } // Bold
  if (/~~[^~]+~~/.test(text)) {
    return true;
  } // Strikethrough
  if (/^#{1,6}\s+/m.test(text)) {
    return true;
  } // Headers
  if (/^>\s+/m.test(text)) {
    return true;
  } // Blockquotes

  return false;
}
