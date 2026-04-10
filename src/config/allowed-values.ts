import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const MAX_ALLOWED_VALUES_HINT = 12;
const MAX_ALLOWED_VALUE_CHARS = 160;

export interface AllowedValuesSummary {
  values: string[];
  hiddenCount: number;
  formatted: string;
}

function truncateHintText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}... (+${text.length - limit} chars)`;
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall back to string coercion when value is not JSON-serializable.
  }
  return String(value);
}

function toAllowedValueLabel(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(truncateHintText(value, MAX_ALLOWED_VALUE_CHARS));
  }
  return truncateHintText(safeStringify(value), MAX_ALLOWED_VALUE_CHARS);
}

function toAllowedValueValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return safeStringify(value);
}

function toAllowedValueDedupKey(value: unknown): string {
  if (value === null) {
    return "null:null";
  }
  const kind = typeof value;
  if (kind === "string") {
    return `string:${value as string}`;
  }
  return `${kind}:${safeStringify(value)}`;
}

export function summarizeAllowedValues(
  values: readonly unknown[],
): AllowedValuesSummary | null {
  if (values.length === 0) {
    return null;
  }

  const deduped: { value: string; label: string }[] = [];
  const seenValues = new Set<string>();
  for (const item of values) {
    const dedupeKey = toAllowedValueDedupKey(item);
    if (seenValues.has(dedupeKey)) {
      continue;
    }
    seenValues.add(dedupeKey);
    deduped.push({
      label: toAllowedValueLabel(item),
      value: toAllowedValueValue(item),
    });
  }

  const shown = deduped.slice(0, MAX_ALLOWED_VALUES_HINT);
  const hiddenCount = deduped.length - shown.length;
  const formattedCore = shown.map((entry) => entry.label).join(", ");
  const formatted =
    hiddenCount > 0 ? `${formattedCore}, ... (+${hiddenCount} more)` : formattedCore;

  return {
    formatted,
    hiddenCount,
    values: shown.map((entry) => entry.value),
  };
}

function messageAlreadyIncludesAllowedValues(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return lower.includes("(allowed:") || lower.includes("expected one of");
}

export function appendAllowedValuesHint(message: string, summary: AllowedValuesSummary): string {
  if (messageAlreadyIncludesAllowedValues(message)) {
    return message;
  }
  return `${message} (allowed: ${summary.formatted})`;
}
