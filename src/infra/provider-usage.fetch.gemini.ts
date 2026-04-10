import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { PROVIDER_LABELS, clampPercent } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

interface GeminiUsageResponse {
  buckets?: { modelId?: string; remainingFraction?: number }[];
}

export async function fetchGeminiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  provider: UsageProviderId,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    {
      body: "{}",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({
      provider,
      status: res.status,
    });
  }

  const data = (await res.json()) as GeminiUsageResponse;
  const quotas: Record<string, number> = {};

  for (const bucket of data.buckets || []) {
    const model = bucket.modelId || "unknown";
    const frac = bucket.remainingFraction ?? 1;
    if (!quotas[model] || frac < quotas[model]) {
      quotas[model] = frac;
    }
  }

  const windows: UsageWindow[] = [];
  let proMin = 1;
  let flashMin = 1;
  let hasPro = false;
  let hasFlash = false;

  for (const [model, frac] of Object.entries(quotas)) {
    const lower = normalizeLowercaseStringOrEmpty(model);
    if (lower.includes("pro")) {
      hasPro = true;
      if (frac < proMin) {
        proMin = frac;
      }
    }
    if (lower.includes("flash")) {
      hasFlash = true;
      if (frac < flashMin) {
        flashMin = frac;
      }
    }
  }

  if (hasPro) {
    windows.push({
      label: "Pro",
      usedPercent: clampPercent((1 - proMin) * 100),
    });
  }
  if (hasFlash) {
    windows.push({
      label: "Flash",
      usedPercent: clampPercent((1 - flashMin) * 100),
    });
  }

  return { displayName: PROVIDER_LABELS[provider], provider, windows };
}
