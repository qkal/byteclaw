export function sanitizeForConsole(text: string | undefined, maxChars = 200): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutControlChars = [...trimmed]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return !(
        code <= 0x08 ||
        code === 0x0B ||
        code === 0x0C ||
        (code >= 0x0E && code <= 0x1F) ||
        code === 0x7F
      );
    })
    .join("");
  const sanitized = withoutControlChars
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}…` : sanitized;
}
