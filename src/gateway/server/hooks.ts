import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import { type HookClientIpConfig, createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
    trustedProxies: cfg.gateway?.trustedProxies,
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey, trusted: false });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const { sessionKey } = value;
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const delivery = value.deliver
      ? {
          channel: value.channel,
          mode: "announce" as const,
          to: value.to,
        }
      : { mode: "none" as const };
    const job: CronJob = {
      agentId: value.agentId,
      createdAtMs: now,
      delivery,
      enabled: true,
      id: jobId,
      name: value.name,
      payload: {
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
      },
      schedule: { at: new Date(now).toISOString(), kind: "at" },
      sessionTarget: "isolated",
      state: { nextRunAtMs: now },
      updatedAtMs: now,
      wakeMode: value.wakeMode,
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deliveryContract: "shared",
          deps,
          job,
          lane: "cron",
          message: value.message,
          sessionKey,
        });
        const summary =
          normalizeOptionalString(result.summary) ||
          normalizeOptionalString(result.error) ||
          result.status;
        const prefix =
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
        if (!result.delivered) {
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
        }
      } catch (error) {
        logHooks.warn(`hook agent failed: ${String(error)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(error)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  return createHooksRequestHandler({
    bindHost,
    dispatchAgentHook,
    dispatchWakeHook,
    getClientIpConfig,
    getHooksConfig,
    logHooks,
    port,
  });
}
