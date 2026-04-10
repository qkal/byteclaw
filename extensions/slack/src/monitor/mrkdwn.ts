export function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([*_`~])/g, String.raw`\$1`);
}
