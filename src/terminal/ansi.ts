// Full CSI: ESC [ <params> <final byte> covers cursor movement, erase, and SGR.
const ANSI_CSI_PATTERN = String.raw`\x1b\[[\x20-\x3f]*[\x40-\x7e]`;
// OSC-8 hyperlinks: ESC ] 8 ; ; url ST ... ESC ] 8 ; ; ST
const OSC8_PATTERN = String.raw`\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\`;

const ANSI_CSI_REGEX = new RegExp(ANSI_CSI_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function stripAnsi(input: string): string {
  return input.replace(OSC8_REGEX, "").replace(ANSI_CSI_REGEX, "");
}

export function splitGraphemes(input: string): string[] {
  if (!input) {
    return [];
  }
  if (!graphemeSegmenter) {
    return [...input];
  }
  try {
    return Array.from(graphemeSegmenter.segment(input), (segment) => segment.segment);
  } catch {
    return [...input];
  }
}

/**
 * Sanitize a value for safe interpolation into log messages.
 * Strips ANSI escape sequences, C0 control characters (U+0000–U+001F),
 * and DEL (U+007F) to prevent log forging / terminal escape injection (CWE-117).
 */
export function sanitizeForLog(v: string): string {
  let out = stripAnsi(v);
  for (let c = 0; c <= 0x1F; c++) {
    out = out.replaceAll(String.fromCharCode(c), "");
  }
  return out.replaceAll(String.fromCharCode(0x7F), "");
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x03_00 && codePoint <= 0x03_6F) ||
    (codePoint >= 0x1A_B0 && codePoint <= 0x1A_FF) ||
    (codePoint >= 0x1D_C0 && codePoint <= 0x1D_FF) ||
    (codePoint >= 0x20_D0 && codePoint <= 0x20_FF) ||
    (codePoint >= 0xFE_20 && codePoint <= 0xFE_2F) ||
    (codePoint >= 0xFE_00 && codePoint <= 0xFE_0F) ||
    codePoint === 0x20_0D
  );
}

function isFullWidthCodePoint(codePoint: number): boolean {
  if (codePoint < 0x11_00) {
    return false;
  }
  return (
    codePoint <= 0x11_5F ||
    codePoint === 0x23_29 ||
    codePoint === 0x23_2A ||
    (codePoint >= 0x2E_80 && codePoint <= 0x32_47 && codePoint !== 0x30_3F) ||
    (codePoint >= 0x32_50 && codePoint <= 0x4D_BF) ||
    (codePoint >= 0x4E_00 && codePoint <= 0xA4_C6) ||
    (codePoint >= 0xA9_60 && codePoint <= 0xA9_7C) ||
    (codePoint >= 0xAC_00 && codePoint <= 0xD7_A3) ||
    (codePoint >= 0xF9_00 && codePoint <= 0xFA_FF) ||
    (codePoint >= 0xFE_10 && codePoint <= 0xFE_19) ||
    (codePoint >= 0xFE_30 && codePoint <= 0xFE_6B) ||
    (codePoint >= 0xFF_01 && codePoint <= 0xFF_60) ||
    (codePoint >= 0xFF_E0 && codePoint <= 0xFF_E6) ||
    (codePoint >= 0x1_AF_F0 && codePoint <= 0x1_AF_F3) ||
    (codePoint >= 0x1_AF_F5 && codePoint <= 0x1_AF_FB) ||
    (codePoint >= 0x1_AF_FD && codePoint <= 0x1_AF_FE) ||
    (codePoint >= 0x1_B0_00 && codePoint <= 0x1_B2_FF) ||
    (codePoint >= 0x1_F2_00 && codePoint <= 0x1_F2_51) ||
    (codePoint >= 0x2_00_00 && codePoint <= 0x3_FF_FD)
  );
}

const emojiLikePattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

function graphemeWidth(grapheme: string): number {
  if (!grapheme) {
    return 0;
  }
  if (emojiLikePattern.test(grapheme)) {
    return 2;
  }

  let sawPrintable = false;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null) {
      continue;
    }
    if (isZeroWidthCodePoint(codePoint)) {
      continue;
    }
    if (isFullWidthCodePoint(codePoint)) {
      return 2;
    }
    sawPrintable = true;
  }
  return sawPrintable ? 1 : 0;
}

export function visibleWidth(input: string): number {
  return splitGraphemes(stripAnsi(input)).reduce(
    (sum, grapheme) => sum + graphemeWidth(grapheme),
    0,
  );
}
