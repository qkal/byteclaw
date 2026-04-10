import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function resolveLegacyGroupSessionKey(ctx: { From?: string }): {
  key: string;
  channel: string;
  id: string;
  chatType: "group";
} | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  const normalized = normalizeLowercaseStringOrEmpty(from);
  if (!from || from.includes(":") || !normalized.endsWith("@g.us")) {
    return null;
  }
  return {
    channel: "whatsapp",
    chatType: "group",
    id: normalized,
    key: `whatsapp:group:${normalized}`,
  };
}
