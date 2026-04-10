import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { type MattermostUser, normalizeMattermostBaseUrl, readMattermostError } from "./client.js";
import type { BaseProbeResult } from "./runtime-api.js";

export type MattermostProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: MattermostUser;
};

export async function probeMattermost(
  baseUrl: string,
  botToken: string,
  timeoutMs = 2500,
  allowPrivateNetwork = false,
): Promise<MattermostProbe> {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    return { error: "baseUrl missing", ok: false };
  }
  const url = `${normalized}/api/v4/users/me`;
  const start = Date.now();
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const { response: res, release } = await fetchWithSsrFGuard({
      auditContext: "mattermost-probe",
      init: {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: controller?.signal,
      },
      policy: ssrfPolicyFromPrivateNetworkOptIn(allowPrivateNetwork),
      url,
    });
    try {
      const elapsedMs = Date.now() - start;
      if (!res.ok) {
        const detail = await readMattermostError(res);
        return {
          elapsedMs,
          error: detail || res.statusText,
          ok: false,
          status: res.status,
        };
      }
      const bot = (await res.json()) as MattermostUser;
      return {
        bot,
        elapsedMs,
        ok: true,
        status: res.status,
      };
    } finally {
      await release();
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    return {
      elapsedMs: Date.now() - start,
      error: message,
      ok: false,
      status: null,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
