import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export interface ParsedLogLine {
  time?: string;
  level?: string;
  subsystem?: string;
  module?: string;
  message: string;
  raw: string;
}

function extractMessage(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(value)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }
    const item = value[key];
    if (typeof item === "string") {
      parts.push(item);
    } else if (item != null) {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join(" ");
}

function parseMetaName(raw?: unknown): { subsystem?: string; module?: string } {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      module: typeof parsed.module === "string" ? parsed.module : undefined,
      subsystem: typeof parsed.subsystem === "string" ? parsed.subsystem : undefined,
    };
  } catch {
    return {};
  }
}

export function parseLogLine(raw: string): ParsedLogLine | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const meta = parsed._meta as Record<string, unknown> | undefined;
    const nameMeta = parseMetaName(meta?.name);
    const levelRaw = typeof meta?.logLevelName === "string" ? meta.logLevelName : undefined;
    return {
      level: normalizeOptionalLowercaseString(levelRaw),
      message: extractMessage(parsed),
      module: nameMeta.module,
      raw,
      subsystem: nameMeta.subsystem,
      time:
        typeof parsed.time === "string"
          ? parsed.time
          : (typeof meta?.date === "string"
            ? meta.date
            : undefined),
    };
  } catch {
    return null;
  }
}
