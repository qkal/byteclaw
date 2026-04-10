import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { ZaloApiError, type ZaloBotInfo, type ZaloFetch, getMe } from "./api.js";

export type ZaloProbeResult = BaseProbeResult<string> & {
  bot?: ZaloBotInfo;
  elapsedMs: number;
};

export async function probeZalo(
  token: string,
  timeoutMs = 5000,
  fetcher?: ZaloFetch,
): Promise<ZaloProbeResult> {
  if (!token?.trim()) {
    return { elapsedMs: 0, error: "No token provided", ok: false };
  }

  const startTime = Date.now();

  try {
    const response = await getMe(token.trim(), timeoutMs, fetcher);
    const elapsedMs = Date.now() - startTime;

    if (response.ok && response.result) {
      return { bot: response.result, elapsedMs, ok: true };
    }

    return { elapsedMs, error: "Invalid response from Zalo API", ok: false };
  } catch (error) {
    const elapsedMs = Date.now() - startTime;

    if (error instanceof ZaloApiError) {
      return { elapsedMs, error: error.description ?? error.message, ok: false };
    }

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return { elapsedMs, error: `Request timed out after ${timeoutMs}ms`, ok: false };
      }
      return { elapsedMs, error: error.message, ok: false };
    }

    return { elapsedMs, error: String(error), ok: false };
  }
}
