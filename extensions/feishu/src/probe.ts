import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { raceWithTimeoutAndAbort } from "./async.js";
import { type FeishuClientCredentials, createFeishuClient } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

/** Cache probe results to reduce repeated health-check calls.
 * Gateway health checks call probeFeishu() every minute; without caching this
 * burns ~43,200 calls/month, easily exceeding Feishu's free-tier quota.
 * Successful bot info is effectively static, while failures are cached briefly
 * to avoid hammering the API during transient outages. */
const probeCache = new Map<string, { result: FeishuProbeResult; expiresAt: number }>();
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROBE_ERROR_TTL_MS = 60 * 1000; // 1 minute
const MAX_PROBE_CACHE_SIZE = 64;
export const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 10_000;
export interface ProbeFeishuOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

interface FeishuBotInfoResponse {
  code: number;
  msg?: string;
  bot?: { bot_name?: string; open_id?: string };
  data?: { bot?: { bot_name?: string; open_id?: string } };
}

type FeishuRequestClient = ReturnType<typeof createFeishuClient> & {
  request(params: {
    method: "GET";
    url: string;
    data: Record<string, never>;
    timeout: number;
  }): Promise<FeishuBotInfoResponse>;
};

function setCachedProbeResult(
  cacheKey: string,
  result: FeishuProbeResult,
  ttlMs: number,
): FeishuProbeResult {
  probeCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, result });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) {
      probeCache.delete(oldest);
    }
  }
  return result;
}

export async function probeFeishu(
  creds?: FeishuClientCredentials,
  options: ProbeFeishuOptions = {},
): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      error: "missing credentials (appId, appSecret)",
      ok: false,
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      appId: creds.appId,
      error: "probe aborted",
      ok: false,
    };
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_PROBE_REQUEST_TIMEOUT_MS;

  // Return cached result if still valid.
  // Use accountId when available; otherwise include appSecret prefix so two
  // Accounts sharing the same appId (e.g. after secret rotation) don't
  // Pollute each other's cache entry.
  const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const client = createFeishuClient(creds) as FeishuRequestClient;
    // Use bot/v3/info API to get bot information
    const responseResult = await raceWithTimeoutAndAbort<FeishuBotInfoResponse>(
      client.request({
        data: {},
        method: "GET",
        timeout: timeoutMs,
        url: "/open-apis/bot/v3/info",
      }),
      {
        abortSignal: options.abortSignal,
        timeoutMs,
      },
    );

    if (responseResult.status === "aborted") {
      return {
        appId: creds.appId,
        error: "probe aborted",
        ok: false,
      };
    }
    if (responseResult.status === "timeout") {
      return setCachedProbeResult(
        cacheKey,
        {
          appId: creds.appId,
          error: `probe timed out after ${timeoutMs}ms`,
          ok: false,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const response = responseResult.value;
    if (options.abortSignal?.aborted) {
      return {
        appId: creds.appId,
        error: "probe aborted",
        ok: false,
      };
    }

    if (response.code !== 0) {
      return setCachedProbeResult(
        cacheKey,
        {
          appId: creds.appId,
          error: `API error: ${response.msg || `code ${response.code}`}`,
          ok: false,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const bot = response.bot || response.data?.bot;
    return setCachedProbeResult(
      cacheKey,
      {
        appId: creds.appId,
        botName: bot?.bot_name,
        botOpenId: bot?.open_id,
        ok: true,
      },
      PROBE_SUCCESS_TTL_MS,
    );
  } catch (error) {
    return setCachedProbeResult(
      cacheKey,
      {
        appId: creds.appId,
        error: formatErrorMessage(error),
        ok: false,
      },
      PROBE_ERROR_TTL_MS,
    );
  }
}

/** Clear the probe cache (for testing). */
export function clearProbeCache(): void {
  probeCache.clear();
}
