function normalizeTrimmedMetadata(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : "";
}

function toLowerAscii(input: string): string {
  return input.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

export function normalizeDeviceMetadataForAuth(value?: string | null): string {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) {
    return "";
  }
  // Keep cross-runtime normalization deterministic (TS/Swift/Kotlin) by only
  // Lowercasing ASCII metadata fields used in auth payloads.
  return toLowerAscii(trimmed);
}

export function normalizeDeviceMetadataForPolicy(value?: string | null): string {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) {
    return "";
  }
  // Policy classification should collapse Unicode confusables to stable ASCII-ish
  // Tokens where possible before matching platform/family rules.
  return normalizeLowercaseStringOrEmpty(trimmed.normalize("NFKD").replace(/\p{M}/gu, ""));
}
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
