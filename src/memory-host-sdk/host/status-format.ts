export type Tone = "ok" | "warn" | "muted";

export function resolveMemoryVectorState(vector: { enabled: boolean; available?: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled" | "unknown";
} {
  if (!vector.enabled) {
    return { state: "disabled", tone: "muted" };
  }
  if (vector.available === true) {
    return { state: "ready", tone: "ok" };
  }
  if (vector.available === false) {
    return { state: "unavailable", tone: "warn" };
  }
  return { state: "unknown", tone: "muted" };
}

export function resolveMemoryFtsState(fts: { enabled: boolean; available: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled";
} {
  if (!fts.enabled) {
    return { state: "disabled", tone: "muted" };
  }
  return fts.available ? { state: "ready", tone: "ok" } : { state: "unavailable", tone: "warn" };
}

export function resolveMemoryCacheSummary(cache: { enabled: boolean; entries?: number }): {
  tone: Tone;
  text: string;
} {
  if (!cache.enabled) {
    return { text: "cache off", tone: "muted" };
  }
  const suffix = typeof cache.entries === "number" ? ` (${cache.entries})` : "";
  return { text: `cache on${suffix}`, tone: "ok" };
}

export function resolveMemoryCacheState(cache: { enabled: boolean }): {
  tone: Tone;
  state: "enabled" | "disabled";
} {
  return cache.enabled ? { state: "enabled", tone: "ok" } : { state: "disabled", tone: "muted" };
}
