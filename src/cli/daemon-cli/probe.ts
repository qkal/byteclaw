import { formatErrorMessage } from "../../infra/errors.js";
import { withProgress } from "../progress.js";

function resolveProbeFailureMessage(result: {
  error?: string | null;
  close?: { code: number; reason: string } | null;
}): string {
  const closeHint = result.close
    ? `gateway closed (${result.close.code}): ${result.close.reason}`
    : null;
  if (closeHint && (!result.error || result.error === "timeout")) {
    return closeHint;
  }
  return result.error ?? closeHint ?? "gateway probe failed";
}

export async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  timeoutMs: number;
  json?: boolean;
  requireRpc?: boolean;
  configPath?: string;
}) {
  try {
    const result = await withProgress(
      {
        enabled: opts.json !== true,
        indeterminate: true,
        label: "Checking gateway status...",
      },
      async () => {
        if (opts.requireRpc) {
          const { callGateway } = await import("../../gateway/call.js");
          await callGateway({
            method: "status",
            password: opts.password,
            timeoutMs: opts.timeoutMs,
            tlsFingerprint: opts.tlsFingerprint,
            token: opts.token,
            url: opts.url,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
          });
          return { ok: true } as const;
        }
        const { probeGateway } = await import("../../gateway/probe.js");
        return await probeGateway({
          auth: {
            password: opts.password,
            token: opts.token,
          },
          includeDetails: false,
          timeoutMs: opts.timeoutMs,
          tlsFingerprint: opts.tlsFingerprint,
          url: opts.url,
        });
      },
    );
    if (result.ok) {
      return { ok: true } as const;
    }
    return {
      error: resolveProbeFailureMessage(result),
      ok: false,
    } as const;
  } catch (error) {
    return {
      error: formatErrorMessage(error),
      ok: false,
    } as const;
  }
}
