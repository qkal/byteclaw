export const SESSION_LABEL_MAX_LENGTH = 512;

export type ParsedSessionLabel = { ok: true; label: string } | { ok: false; error: string };

export function parseSessionLabel(raw: unknown): ParsedSessionLabel {
  if (typeof raw !== "string") {
    return { error: "invalid label: must be a string", ok: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "invalid label: empty", ok: false };
  }
  if (trimmed.length > SESSION_LABEL_MAX_LENGTH) {
    return {
      error: `invalid label: too long (max ${SESSION_LABEL_MAX_LENGTH})`,
      ok: false,
    };
  }
  return { label: trimmed, ok: true };
}
