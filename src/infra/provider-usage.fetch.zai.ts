import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { PROVIDER_LABELS, clampPercent } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

interface ZaiUsageResponse {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: {
    planName?: string;
    plan?: string;
    limits?: {
      type?: string;
      percentage?: number;
      unit?: number;
      number?: number;
      nextResetTime?: string;
    }[];
  };
}

export async function fetchZaiUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.z.ai/api/monitor/usage/quota/limit",
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      method: "GET",
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({
      provider: "zai",
      status: res.status,
    });
  }

  const data = (await res.json()) as ZaiUsageResponse;
  if (!data.success || data.code !== 200) {
    const errorMessage = typeof data.msg === "string" ? data.msg.trim() : "";
    return {
      displayName: PROVIDER_LABELS.zai,
      error: errorMessage || "API error",
      provider: "zai",
      windows: [],
    };
  }

  const windows: UsageWindow[] = [];
  const limits = data.data?.limits || [];

  for (const limit of limits) {
    const percent = clampPercent(limit.percentage || 0);
    const nextReset = limit.nextResetTime ? new Date(limit.nextResetTime).getTime() : undefined;
    let windowLabel = "Limit";
    if (limit.unit === 1) {
      windowLabel = `${limit.number}d`;
    } else if (limit.unit === 3) {
      windowLabel = `${limit.number}h`;
    } else if (limit.unit === 5) {
      windowLabel = `${limit.number}m`;
    }

    if (limit.type === "TOKENS_LIMIT") {
      windows.push({
        label: `Tokens (${windowLabel})`,
        resetAt: nextReset,
        usedPercent: percent,
      });
    } else if (limit.type === "TIME_LIMIT") {
      windows.push({
        label: "Monthly",
        resetAt: nextReset,
        usedPercent: percent,
      });
    }
  }

  const planName = data.data?.planName || data.data?.plan || undefined;
  return {
    displayName: PROVIDER_LABELS.zai,
    plan: planName,
    provider: "zai",
    windows,
  };
}
