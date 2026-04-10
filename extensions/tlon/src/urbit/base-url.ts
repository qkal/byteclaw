import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export type UrbitBaseUrlValidation =
  | { ok: true; baseUrl: string; hostname: string }
  | { ok: false; error: string };

function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

export function normalizeUrbitHostname(hostname: string | undefined): string {
  return normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
}

export function validateUrbitBaseUrl(raw: string): UrbitBaseUrlValidation {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { error: "Required", ok: false };
  }

  const candidate = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "Invalid URL", ok: false };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { error: "URL must use http:// or https://", ok: false };
  }

  if (parsed.username || parsed.password) {
    return { error: "URL must not include credentials", ok: false };
  }

  const hostname = normalizeUrbitHostname(parsed.hostname);
  if (!hostname) {
    return { error: "Invalid hostname", ok: false };
  }

  // Normalize to origin so callers can't smuggle paths/query fragments into the base URL,
  // And strip a trailing dot from the hostname (DNS root label).
  const isIpv6 = hostname.includes(":");
  const host = parsed.port
    ? `${isIpv6 ? `[${hostname}]` : hostname}:${parsed.port}`
    : (isIpv6
      ? `[${hostname}]`
      : hostname);

  return { baseUrl: `${parsed.protocol}//${host}`, hostname, ok: true };
}

export function isBlockedUrbitHostname(hostname: string): boolean {
  const normalized = normalizeUrbitHostname(hostname);
  if (!normalized) {
    return false;
  }
  return isBlockedHostnameOrIp(normalized);
}
