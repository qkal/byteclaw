import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { isBlockedHostnameOrIp } from "../runtime-api.js";

export function validateUrlSafety(urlStr: string): { ok: true } | { ok: false; error: string } {
  try {
    const url = new URL(urlStr);

    if (url.protocol !== "https:") {
      return { error: "URL must use https:// protocol", ok: false };
    }

    const hostname = normalizeLowercaseStringOrEmpty(url.hostname);

    if (isBlockedHostnameOrIp(hostname)) {
      return { error: "URL must not point to private/internal addresses", ok: false };
    }

    return { ok: true };
  } catch {
    return { error: "Invalid URL format", ok: false };
  }
}
