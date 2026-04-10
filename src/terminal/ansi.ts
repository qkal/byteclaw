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
  for (let c = 0; c <= 0x1f; c++) {
    out = out.replaceAll(String.fromCharCode(c), "");
  }
  return out.replaceAll(String.fromCharCode(0x7f), "");
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x03_00 && codePoint <= 0x03_6f) ||
    (codePoint >= 0x1a_b0 && codePoint <= 0x1a_ff) ||
    (codePoint >= 0x1d_c0 && codePoint <= 0x1d_ff) ||
    (codePoint >= 0x20_d0 && codePoint <= 0x20_ff) ||
    (codePoint >= 0xfe_20 && codePoint <= 0xfe_2f) ||
    (codePoint >= 0xfe_00 && codePoint <= 0xfe_0f) ||
    codePoint === 0x20_0d
  );
}

function isFullWidthCodePoint(codePoint: number): boolean {
  if (codePoint < 0x11_00) {
    return false;
  }
  return (
    codePoint <= 0x11_5f ||
    codePoint === 0x23_29 ||
    codePoint === 0x23_2a ||
    (codePoint >= 0x2e_80 && codePoint <= 0x32_47 && codePoint !== 0x30_3f) ||
    (codePoint >= 0x32_50 && codePoint <= 0x4d_bf) ||
    (codePoint >= 0x4e_00 && codePoint <= 0xa4_c6) ||
    (codePoint >= 0xa9_60 && codePoint <= 0xa9_7c) ||
    (codePoint >= 0xac_00 && codePoint <= 0xd7_a3) ||
    (codePoint >= 0xf9_00 && codePoint <= 0xfa_ff) ||
    (codePoint >= 0xfe_10 && codePoint <= 0xfe_19) ||
    (codePoint >= 0xfe_30 && codePoint <= 0xfe_6b) ||
    (codePoint >= 0xff_01 && codePoint <= 0xff_60) ||
    (codePoint >= 0xff_e0 && codePoint <= 0xff_e6) ||
    (codePoint >= 0x1_af_f0 && codePoint <= 0x1_af_f3) ||
    (codePoint >= 0x1_af_f5 && codePoint <= 0x1_af_fb) ||
    (codePoint >= 0x1_af_fd && codePoint <= 0x1_af_fe) ||
    (codePoint >= 0x1_b0_00 && codePoint <= 0x1_b2_ff) ||
    (codePoint >= 0x1_f2_00 && codePoint <= 0x1_f2_51) ||
    (codePoint >= 0x2_00_00 && codePoint <= 0x3_ff_fd)
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
