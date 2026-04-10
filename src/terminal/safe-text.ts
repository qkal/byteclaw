import { stripAnsi } from "./ansi.js";

/**
 * Normalize untrusted text for single-line terminal/log rendering.
 */
export function sanitizeTerminalText(input: string): string {
  const normalized = stripAnsi(input)
    .replace(/\r/g, String.raw`\r`)
    .replace(/\n/g, String.raw`\n`)
    .replace(/\t/g, String.raw`\t`);
  let sanitized = "";
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1F) || (code >= 0x7F && code <= 0x9F);
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized;
}
