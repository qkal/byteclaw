import { type Style, TextStyle } from "./zca-constants.js";

const ESCAPE_SENTINEL_START = "\u0001";
const ESCAPE_SENTINEL_END = "\u0002";

type InlineStyle = (typeof TextStyle)[keyof typeof TextStyle];

interface LineStyle {
  lineIndex: number;
  style: InlineStyle;
  indentSize?: number;
}

interface Segment {
  text: string;
  styles: InlineStyle[];
}

interface InlineMarker {
  pattern: RegExp;
  extractText: (match: RegExpExecArray) => string;
  resolveStyles?: (match: RegExpExecArray) => InlineStyle[];
  literal?: boolean;
}

interface ResolvedInlineMatch {
  match: RegExpExecArray;
  marker: InlineMarker;
  styles: InlineStyle[];
  text: string;
  priority: number;
}

interface FenceMarker {
  char: "`" | "~";
  length: number;
  indent: number;
}

type ActiveFence = FenceMarker & {
  quoteIndent: number;
};

const TAG_STYLE_MAP: Record<string, InlineStyle | null> = {
  big: TextStyle.Big,
  green: TextStyle.Green,
  orange: TextStyle.Orange,
  red: TextStyle.Red,
  small: null,
  underline: TextStyle.Underline,
  yellow: TextStyle.Yellow,
};

const INLINE_MARKERS: InlineMarker[] = [
  {
    extractText: (match) => match[0],
    literal: true,
    pattern: /`([^`\n]+)`/g,
  },
  {
    extractText: (match) => match[1],
    literal: true,
    pattern: /\\([*_~#\\{}>+\-`])/g,
  },
  {
    extractText: (match) => match[2],
    pattern: new RegExp(`\\{(${Object.keys(TAG_STYLE_MAP).join("|")})\\}(.+?)\\{/\\1\\}`, "g"),
    resolveStyles: (match) => {
      const style = TAG_STYLE_MAP[match[1]];
      return style ? [style] : [];
    },
  },
  {
    extractText: (match) => match[1],
    pattern: /(?<!\*)\*\*\*(?=\S)([^\n]*?\S)(?<!\*)\*\*\*(?!\*)/g,
    resolveStyles: () => [TextStyle.Bold, TextStyle.Italic],
  },
  {
    extractText: (match) => match[1],
    pattern: /(?<!\*)\*\*(?![\s*])([^\n]*?\S)(?<!\*)\*\*(?!\*)/g,
    resolveStyles: () => [TextStyle.Bold],
  },
  {
    extractText: (match) => match[1],
    pattern: /(?<![\w_])__(?![\s_])([^\n]*?\S)(?<!_)__(?![\w_])/g,
    resolveStyles: () => [TextStyle.Bold],
  },
  {
    extractText: (match) => match[1],
    pattern: /(?<!~)~~(?=\S)([^\n]*?\S)(?<!~)~~(?!~)/g,
    resolveStyles: () => [TextStyle.StrikeThrough],
  },
  {
    extractText: (match) => match[1],
    pattern: /(?<!\*)\*(?![\s*])([^\n]*?\S)(?<!\*)\*(?!\*)/g,
    resolveStyles: () => [TextStyle.Italic],
  },
  {
    extractText: (match) => match[1],
    pattern: /(?<![\w_])_(?![\s_])([^\n]*?\S)(?<!_)_(?![\w_])/g,
    resolveStyles: () => [TextStyle.Italic],
  },
];

export function parseZalouserTextStyles(input: string): { text: string; styles: Style[] } {
  const allStyles: Style[] = [];

  const escapeMap: string[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const lineStyles: LineStyle[] = [];
  const processedLines: string[] = [];
  let activeFence: ActiveFence | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const { text: unquotedLine, indent: baseIndent } = stripQuotePrefix(rawLine);

    if (activeFence) {
      const codeLine =
        activeFence.quoteIndent > 0
          ? stripQuotePrefix(rawLine, activeFence.quoteIndent).text
          : rawLine;
      if (isClosingFence(codeLine, activeFence)) {
        activeFence = null;
        continue;
      }
      processedLines.push(
        escapeLiteralText(
          normalizeCodeBlockLeadingWhitespace(stripCodeFenceIndent(codeLine, activeFence.indent)),
          escapeMap,
        ),
      );
      continue;
    }

    const line = unquotedLine;
    const openingFence = resolveOpeningFence(rawLine);
    if (openingFence) {
      const fenceLine = openingFence.quoteIndent > 0 ? unquotedLine : rawLine;
      if (!hasClosingFence(lines, lineIndex + 1, openingFence)) {
        processedLines.push(escapeLiteralText(fenceLine, escapeMap));
        activeFence = openingFence;
        continue;
      }
      activeFence = openingFence;
      continue;
    }

    const outputLineIndex = processedLines.length;
    if (isIndentedCodeBlockLine(line)) {
      if (baseIndent > 0) {
        lineStyles.push({
          indentSize: baseIndent,
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
        });
      }
      processedLines.push(escapeLiteralText(normalizeCodeBlockLeadingWhitespace(line), escapeMap));
      continue;
    }

    const { text: markdownLine, size: markdownPadding } = stripOptionalMarkdownPadding(line);

    const headingMatch = markdownLine.match(/^(#{1,4})\s(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.Bold });
      if (depth === 1) {
        lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.Big });
      }
      if (baseIndent > 0) {
        lineStyles.push({
          indentSize: baseIndent,
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
        });
      }
      processedLines.push(headingMatch[2]);
      continue;
    }

    const indentMatch = markdownLine.match(/^(\s+)(.*)$/);
    let indentLevel = 0;
    let content = markdownLine;
    if (indentMatch) {
      indentLevel = clampIndent(indentMatch[1].length);
      content = indentMatch[2];
    }
    const totalIndent = Math.min(5, baseIndent + indentLevel);

    if (/^[-*+]\s\[[ xX]\]\s/.test(content)) {
      if (totalIndent > 0) {
        lineStyles.push({
          indentSize: totalIndent,
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
        });
      }
      processedLines.push(content);
      continue;
    }

    const orderedListMatch = content.match(/^(\d+)\.\s(.*)$/);
    if (orderedListMatch) {
      if (totalIndent > 0) {
        lineStyles.push({
          indentSize: totalIndent,
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
        });
      }
      lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.OrderedList });
      processedLines.push(orderedListMatch[2]);
      continue;
    }

    const unorderedListMatch = content.match(/^[-*+]\s(.*)$/);
    if (unorderedListMatch) {
      if (totalIndent > 0) {
        lineStyles.push({
          indentSize: totalIndent,
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
        });
      }
      lineStyles.push({ lineIndex: outputLineIndex, style: TextStyle.UnorderedList });
      processedLines.push(unorderedListMatch[1]);
      continue;
    }

    if (markdownPadding > 0) {
      if (baseIndent > 0) {
        lineStyles.push({
          indentSize: baseIndent,
          lineIndex: outputLineIndex,
          style: TextStyle.Indent,
        });
      }
      processedLines.push(line);
      continue;
    }

    if (totalIndent > 0) {
      lineStyles.push({
        indentSize: totalIndent,
        lineIndex: outputLineIndex,
        style: TextStyle.Indent,
      });
      processedLines.push(content);
      continue;
    }

    processedLines.push(line);
  }

  const segments = parseInlineSegments(processedLines.join("\n"));

  let plainText = "";
  for (const segment of segments) {
    const start = plainText.length;
    plainText += segment.text;
    for (const style of segment.styles) {
      allStyles.push({ len: segment.text.length, st: style, start } as Style);
    }
  }

  if (escapeMap.length > 0) {
    const escapeRegex = new RegExp(`${ESCAPE_SENTINEL_START}(\\d+)${ESCAPE_SENTINEL_END}`, "g");
    const shifts: { pos: number; delta: number }[] = [];
    let cumulativeDelta = 0;

    for (const match of plainText.matchAll(escapeRegex)) {
      const escapeIndex = Number.parseInt(match[1], 10);
      cumulativeDelta += match[0].length - escapeMap[escapeIndex].length;
      shifts.push({ delta: cumulativeDelta, pos: (match.index ?? 0) + match[0].length });
    }

    for (const style of allStyles) {
      let startDelta = 0;
      let endDelta = 0;
      const end = style.start + style.len;
      for (const shift of shifts) {
        if (shift.pos <= style.start) {
          startDelta = shift.delta;
        }
        if (shift.pos <= end) {
          endDelta = shift.delta;
        }
      }
      style.start -= startDelta;
      style.len -= endDelta - startDelta;
    }

    plainText = plainText.replace(
      escapeRegex,
      (_match, index) => escapeMap[Number.parseInt(index, 10)],
    );
  }

  const finalLines = plainText.split("\n");
  let offset = 0;
  for (let lineIndex = 0; lineIndex < finalLines.length; lineIndex += 1) {
    const lineLength = finalLines[lineIndex].length;
    if (lineLength > 0) {
      for (const lineStyle of lineStyles) {
        if (lineStyle.lineIndex !== lineIndex) {
          continue;
        }

        if (lineStyle.style === TextStyle.Indent) {
          allStyles.push({
            indentSize: lineStyle.indentSize,
            len: lineLength,
            st: TextStyle.Indent,
            start: offset,
          });
        } else {
          allStyles.push({ len: lineLength, st: lineStyle.style, start: offset } as Style);
        }
      }
    }
    offset += lineLength + 1;
  }

  return { styles: allStyles, text: plainText };
}

function clampIndent(spaceCount: number): number {
  return Math.min(5, Math.max(1, Math.floor(spaceCount / 2)));
}

function stripOptionalMarkdownPadding(line: string): { text: string; size: number } {
  const match = line.match(/^( {1,3})(?=\S)/);
  if (!match) {
    return { size: 0, text: line };
  }
  return {
    size: match[1].length,
    text: line.slice(match[1].length),
  };
}

function hasClosingFence(lines: string[], startIndex: number, fence: ActiveFence): boolean {
  for (let index = startIndex; index < lines.length; index += 1) {
    const candidate =
      fence.quoteIndent > 0 ? stripQuotePrefix(lines[index], fence.quoteIndent).text : lines[index];
    if (isClosingFence(candidate, fence)) {
      return true;
    }
  }
  return false;
}

function resolveOpeningFence(line: string): ActiveFence | null {
  const directFence = parseFenceMarker(line);
  if (directFence) {
    return { ...directFence, quoteIndent: 0 };
  }

  const quoted = stripQuotePrefix(line);
  if (quoted.indent === 0) {
    return null;
  }

  const quotedFence = parseFenceMarker(quoted.text);
  if (!quotedFence) {
    return null;
  }

  return {
    ...quotedFence,
    quoteIndent: quoted.indent,
  };
}

function stripQuotePrefix(
  line: string,
  maxDepth = Number.POSITIVE_INFINITY,
): { text: string; indent: number } {
  let cursor = 0;
  while (cursor < line.length && cursor < 3 && line[cursor] === " ") {
    cursor += 1;
  }

  let removedDepth = 0;
  let consumedCursor = cursor;
  while (removedDepth < maxDepth && consumedCursor < line.length && line[consumedCursor] === ">") {
    removedDepth += 1;
    consumedCursor += 1;
    if (line[consumedCursor] === " ") {
      consumedCursor += 1;
    }
  }

  if (removedDepth === 0) {
    return { indent: 0, text: line };
  }

  return {
    indent: Math.min(5, removedDepth),
    text: line.slice(consumedCursor),
  };
}

function parseFenceMarker(line: string): FenceMarker | null {
  const match = line.match(/^([ ]{0,3})(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }

  const marker = match[2];
  const char = marker[0];
  if (char !== "`" && char !== "~") {
    return null;
  }

  return {
    char,
    indent: match[1].length,
    length: marker.length,
  };
}

function isClosingFence(line: string, fence: FenceMarker): boolean {
  const match = line.match(/^([ ]{0,3})(`{3,}|~{3,})[ \t]*$/);
  if (!match) {
    return false;
  }
  return match[2][0] === fence.char && match[2].length >= fence.length;
}

function escapeLiteralText(input: string, escapeMap: string[]): string {
  return input.replace(/[\\*_~{}`]/g, (ch) => {
    const index = escapeMap.length;
    escapeMap.push(ch);
    return `\x01${index}\x02`;
  });
}

function parseInlineSegments(text: string, inheritedStyles: InlineStyle[] = []): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const nextMatch = findNextInlineMatch(text, cursor);
    if (!nextMatch) {
      pushSegment(segments, text.slice(cursor), inheritedStyles);
      break;
    }

    if (nextMatch.match.index > cursor) {
      pushSegment(segments, text.slice(cursor, nextMatch.match.index), inheritedStyles);
    }

    const combinedStyles = [...inheritedStyles, ...nextMatch.styles];
    if (nextMatch.marker.literal) {
      pushSegment(segments, nextMatch.text, combinedStyles);
    } else {
      segments.push(...parseInlineSegments(nextMatch.text, combinedStyles));
    }

    cursor = nextMatch.match.index + nextMatch.match[0].length;
  }

  return segments;
}

function findNextInlineMatch(text: string, startIndex: number): ResolvedInlineMatch | null {
  let bestMatch: ResolvedInlineMatch | null = null;

  for (const [priority, marker] of INLINE_MARKERS.entries()) {
    const regex = new RegExp(marker.pattern.source, marker.pattern.flags);
    regex.lastIndex = startIndex;
    const match = regex.exec(text);
    if (!match) {
      continue;
    }

    if (
      bestMatch &&
      (match.index > bestMatch.match.index ||
        (match.index === bestMatch.match.index && priority > bestMatch.priority))
    ) {
      continue;
    }

    bestMatch = {
      marker,
      match,
      priority,
      styles: marker.resolveStyles?.(match) ?? [],
      text: marker.extractText(match),
    };
  }

  return bestMatch;
}

function pushSegment(segments: Segment[], text: string, styles: InlineStyle[]): void {
  if (!text) {
    return;
  }

  const lastSegment = segments.at(-1);
  if (lastSegment && sameStyles(lastSegment.styles, styles)) {
    lastSegment.text += text;
    return;
  }

  segments.push({
    styles: [...styles],
    text,
  });
}

function sameStyles(left: InlineStyle[], right: InlineStyle[]): boolean {
  return left.length === right.length && left.every((style, index) => style === right[index]);
}

function normalizeCodeBlockLeadingWhitespace(line: string): string {
  return line.replace(/^[ \t]+/, (leadingWhitespace) =>
    leadingWhitespace.replace(/\t/g, "\u00A0\u00A0\u00A0\u00A0").replace(/ /g, "\u00A0"),
  );
}

function isIndentedCodeBlockLine(line: string): boolean {
  return /^(?: {4,}|\t)/.test(line);
}

function stripCodeFenceIndent(line: string, indent: number): string {
  let consumed = 0;
  let cursor = 0;

  while (cursor < line.length && consumed < indent && line[cursor] === " ") {
    cursor += 1;
    consumed += 1;
  }

  return line.slice(cursor);
}
