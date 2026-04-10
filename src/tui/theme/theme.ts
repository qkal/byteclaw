import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";
import { createSyntaxTheme } from "./syntax-theme.js";

const DARK_TEXT = "#E8E3D5";
const LIGHT_TEXT = "#1E1E1E";
const XTERM_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function channelToSrgb(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.039_28 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminanceRgb(r: number, g: number, b: number): number {
  const red = channelToSrgb(r);
  const green = channelToSrgb(g);
  const blue = channelToSrgb(b);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function relativeLuminanceHex(hex: string): number {
  return relativeLuminanceRgb(
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  );
}

function contrastRatio(background: number, foregroundHex: string): number {
  const foreground = relativeLuminanceHex(foregroundHex);
  const lighter = Math.max(background, foreground);
  const darker = Math.min(background, foreground);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickHigherContrastText(r: number, g: number, b: number): boolean {
  const background = relativeLuminanceRgb(r, g, b);
  return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT);
}

function isLightBackground(): boolean {
  const explicit = normalizeOptionalLowercaseString(process.env.OPENCLAW_THEME);
  if (explicit === "light") {
    return true;
  }
  if (explicit === "dark") {
    return false;
  }

  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg && colorfgbg.length <= 64) {
    const sep = colorfgbg.lastIndexOf(";");
    const bg = Number.parseInt(sep !== -1 ? colorfgbg.slice(sep + 1) : colorfgbg, 10);
    if (bg >= 0 && bg <= 255) {
      if (bg <= 15) {
        return bg === 7 || bg === 15;
      }
      if (bg >= 232) {
        return bg >= 244;
      }
      const cubeIndex = bg - 16;
      const bVal = XTERM_LEVELS[cubeIndex % 6];
      const gVal = XTERM_LEVELS[Math.floor(cubeIndex / 6) % 6];
      const rVal = XTERM_LEVELS[Math.floor(cubeIndex / 36)];
      return pickHigherContrastText(rVal, gVal, bVal);
    }
  }
  return false;
}

/** Whether the terminal has a light background. Exported for testing only. */
export const lightMode = isLightBackground();

export const darkPalette = {
  accent: "#F6C453",
  accentSoft: "#F2A65A",
  border: "#3C414B",
  code: "#F0C987",
  codeBlock: "#1E232A",
  codeBorder: "#343A45",
  dim: "#7B7F87",
  error: "#F97066",
  link: "#7DD3A5",
  quote: "#8CC8FF",
  quoteBorder: "#3B4D6B",
  success: "#7DD3A5",
  systemText: "#9BA3B2",
  text: "#E8E3D5",
  toolErrorBg: "#2F1F1F",
  toolOutput: "#E1DACB",
  toolPendingBg: "#1F2A2F",
  toolSuccessBg: "#1E2D23",
  toolTitle: "#F6C453",
  userBg: "#2B2F36",
  userText: "#F3EEE0",
} as const;

export const lightPalette = {
  accent: "#B45309",
  accentSoft: "#C2410C",
  border: "#5B6472",
  code: "#92400E",
  codeBlock: "#F9FAFB",
  codeBorder: "#92400E",
  dim: "#5B6472",
  error: "#DC2626",
  link: "#047857",
  quote: "#1D4ED8",
  quoteBorder: "#2563EB",
  success: "#047857",
  systemText: "#4B5563",
  text: "#1E1E1E",
  toolErrorBg: "#FEF2F2",
  toolOutput: "#374151",
  toolPendingBg: "#EFF6FF",
  toolSuccessBg: "#ECFDF5",
  toolTitle: "#B45309",
  userBg: "#F3F0E8",
  userText: "#1E1E1E",
} as const;

export const palette = lightMode ? lightPalette : darkPalette;

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

const syntaxTheme = createSyntaxTheme(fg(palette.code), lightMode);

/**
 * Highlight code with syntax coloring.
 * Returns an array of lines with ANSI escape codes.
 */
function highlightCode(code: string, lang?: string): string[] {
  try {
    // Auto-detect can be slow for very large blocks; prefer explicit language when available.
    // Check if language is supported, fall back to auto-detect
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      ignoreIllegals: true,
      language,
      theme: syntaxTheme,
    });
    return highlighted.split("\n");
  } catch {
    // If highlighting fails, return plain code
    return code.split("\n").map((line) => fg(palette.code)(line));
  }
}

export const theme = {
  accent: fg(palette.accent),
  accentSoft: fg(palette.accentSoft),
  assistantText: (text: string) => text,
  bold: (text: string) => chalk.bold(text),
  border: fg(palette.border),
  dim: fg(palette.dim),
  error: fg(palette.error),
  fg: fg(palette.text),
  header: (text: string) => chalk.bold(fg(palette.accent)(text)),
  italic: (text: string) => chalk.italic(text),
  success: fg(palette.success),
  system: fg(palette.systemText),
  toolErrorBg: bg(palette.toolErrorBg),
  toolOutput: fg(palette.toolOutput),
  toolPendingBg: bg(palette.toolPendingBg),
  toolSuccessBg: bg(palette.toolSuccessBg),
  toolTitle: fg(palette.toolTitle),
  userBg: bg(palette.userBg),
  userText: fg(palette.userText),
};

export const markdownTheme: MarkdownTheme = {
  bold: (text) => chalk.bold(text),
  code: (text) => fg(palette.code)(text),
  codeBlock: (text) => fg(palette.code)(text),
  codeBlockBorder: (text) => fg(palette.codeBorder)(text),
  heading: (text) => chalk.bold(fg(palette.accent)(text)),
  highlightCode,
  hr: (text) => fg(palette.border)(text),
  italic: (text) => chalk.italic(text),
  link: (text) => fg(palette.link)(text),
  linkUrl: (text) => chalk.dim(text),
  listBullet: (text) => fg(palette.accentSoft)(text),
  quote: (text) => fg(palette.quote)(text),
  quoteBorder: (text) => fg(palette.quoteBorder)(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};

const baseSelectListTheme: SelectListTheme = {
  description: (text) => fg(palette.dim)(text),
  noMatch: (text) => fg(palette.dim)(text),
  scrollInfo: (text) => fg(palette.dim)(text),
  selectedPrefix: (text) => fg(palette.accent)(text),
  selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
};

export const selectListTheme: SelectListTheme = baseSelectListTheme;

export const filterableSelectListTheme = {
  ...baseSelectListTheme,
  filterLabel: (text: string) => fg(palette.dim)(text),
};

export const settingsListTheme: SettingsListTheme = {
  cursor: fg(palette.accent)("→ "),
  description: (text) => fg(palette.systemText)(text),
  hint: (text) => fg(palette.dim)(text),
  label: (text, selected) =>
    selected ? chalk.bold(fg(palette.accent)(text)) : fg(palette.text)(text),
  value: (text, selected) => (selected ? fg(palette.accentSoft)(text) : fg(palette.dim)(text)),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => fg(palette.border)(text),
  selectList: selectListTheme,
};

export const searchableSelectListTheme: SearchableSelectListTheme = {
  ...baseSelectListTheme,
  matchHighlight: (text) => chalk.bold(fg(palette.accent)(text)),
  searchInput: (text) => fg(palette.text)(text),
  searchPrompt: (text) => fg(palette.accentSoft)(text),
};
