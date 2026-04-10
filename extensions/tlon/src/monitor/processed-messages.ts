import { createDedupeCache } from "../../runtime-api.js";

export interface ProcessedMessageTracker {
  mark: (id?: string | null) => boolean;
  has: (id?: string | null) => boolean;
  size: () => number;
}

export function createProcessedMessageTracker(limit = 2000): ProcessedMessageTracker {
  const dedupe = createDedupeCache({ maxSize: limit, ttlMs: 0 });

  const mark = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return true;
    }
    return !dedupe.check(trimmed);
  };

  const has = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return false;
    }
    return dedupe.peek(trimmed);
  };

  return {
    has,
    mark,
    size: () => dedupe.size(),
  };
}
