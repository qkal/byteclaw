import { type VerboseLevel, normalizeVerboseLevel } from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";

export function parseVerboseOverride(
  raw: unknown,
): { ok: true; value: VerboseLevel | null | undefined } | { ok: false; error: string } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return { error: 'invalid verboseLevel (use "on"|"off")', ok: false };
  }
  const normalized = normalizeVerboseLevel(raw);
  if (!normalized) {
    return { error: 'invalid verboseLevel (use "on"|"off")', ok: false };
  }
  return { ok: true, value: normalized };
}

export function applyVerboseOverride(entry: SessionEntry, level: VerboseLevel | null | undefined) {
  if (level === undefined) {
    return;
  }
  if (level === null) {
    delete entry.verboseLevel;
    return;
  }
  entry.verboseLevel = level;
}
