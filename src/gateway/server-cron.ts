import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  resolveCronDeliveryPlan,
  resolveFailureDestination,
  sendFailureNotificationAnnounce,
} from "../cron/delivery.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { assertSafeCronSessionTargetId } from "../cron/session-target.js";
import { resolveCronStorePath } from "../cron/store.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export interface GatewayCronState {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
}

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

interface CronWebhookTarget {
  url: string;
  source: "delivery" | "legacy";
}

function resolveCronWebhookTarget(params: {
  delivery?: { mode?: string; to?: string };
  legacyNotify?: boolean;
  legacyWebhook?: string;
}): CronWebhookTarget | null {
  const mode = normalizeOptionalLowercaseString(params.delivery?.mode);
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    return url ? { source: "delivery", url } : null;
  }

  if (params.legacyNotify) {
    const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
    if (legacyUrl) {
      return { source: "legacy", url: legacyUrl };
    }
  }

  return null;
}

function buildCronWebhookHeaders(webhookToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (webhookToken) {
    headers.Authorization = `Bearer ${webhookToken}`;
  }
  return headers;
}

async function postCronWebhook(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  logContext: Record<string, unknown>;
  blockedLog: string;
  failedLog: string;
  logger: ReturnType<typeof getChildLogger>;
}): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, CRON_WEBHOOK_TIMEOUT_MS);

  try {
    const result = await fetchWithSsrFGuard({
      init: {
        body: JSON.stringify(params.payload),
        headers: buildCronWebhookHeaders(params.webhookToken),
        method: "POST",
        signal: abortController.signal,
      },
      url: params.webhookUrl,
    });
    await result.release();
  } catch (error) {
    if (error instanceof SsrFBlockedError) {
      params.logger.warn(
        {
          ...params.logContext,
          reason: formatErrorMessage(error),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.blockedLog,
      );
    } else {
      params.logger.warn(
        {
          ...params.logContext,
          err: formatErrorMessage(error),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.failedLog,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (params: {
    runtimeConfig: ReturnType<typeof loadConfig>;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = params.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        agentId: params.agentId,
        cfg: params.runtimeConfig,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: params.agentId,
      mainKey: params.runtimeConfig.session?.mainKey,
      requestKey: requested,
    });
    const canonical = canonicalizeMainSessionAlias({
      agentId: params.agentId,
      cfg: params.runtimeConfig,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(params.agentId)) {
        return resolveAgentMainSessionKey({
          agentId: params.agentId,
          cfg: params.runtimeConfig,
        });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const runtimeConfig = loadConfig();
    const requestedAgentId = opts?.agentId ? resolveCronAgent(opts.agentId).agentId : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const agentId = derivedAgentId || undefined;
    const sessionKey =
      opts?.sessionKey && agentId
        ? resolveCronSessionKey({
            agentId,
            requestedSessionKey: opts.sessionKey,
            runtimeConfig,
          })
        : undefined;
    return { agentId, runtimeConfig, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const warnedLegacyWebhookJobs = new Set<string>();

  const cron = new CronService({
    cronConfig: params.cfg.cron,
    cronEnabled,
    defaultAgentId,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        agentId,
        requestedSessionKey: opts?.sessionKey,
        runtimeConfig,
      });
      enqueueSystemEvent(text, { contextKey: opts?.contextKey, sessionKey });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const webhookToken = normalizeOptionalString(params.cfg.cron?.webhookToken);
        const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);
        const job = cron.getJob(evt.jobId);
        const legacyNotify = (job as { notify?: unknown } | undefined)?.notify === true;
        const webhookTarget = resolveCronWebhookTarget({
          delivery:
            job?.delivery && typeof job.delivery.mode === "string"
              ? { mode: job.delivery.mode, to: job.delivery.to }
              : undefined,
          legacyNotify,
          legacyWebhook,
        });

        if (!webhookTarget && job?.delivery?.mode === "webhook") {
          cronLogger.warn(
            {
              deliveryTo: job.delivery.to,
              jobId: evt.jobId,
            },
            "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
          );
        }

        if (webhookTarget?.source === "legacy" && !warnedLegacyWebhookJobs.has(evt.jobId)) {
          warnedLegacyWebhookJobs.add(evt.jobId);
          cronLogger.warn(
            {
              jobId: evt.jobId,
              legacyWebhook: redactWebhookUrl(webhookTarget.url),
            },
            "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to",
          );
        }

        if (webhookTarget && evt.summary) {
          void (async () => {
            await postCronWebhook({
              blockedLog: "cron: webhook delivery blocked by SSRF guard",
              failedLog: "cron: webhook delivery failed",
              logContext: { jobId: evt.jobId },
              logger: cronLogger,
              payload: evt,
              webhookToken,
              webhookUrl: webhookTarget.url,
            });
          })();
        }

        if (evt.status === "error" && job) {
          const isBestEffort = job.delivery?.bestEffort === true;
          if (!isBestEffort) {
            const failureMessage = `Cron job "${job.name}" failed: ${evt.error ?? "unknown error"}`;
            const failureDest = resolveFailureDestination(job, params.cfg.cron?.failureDestination);

            if (failureDest) {
              // Explicit failureDestination configured — use it
              const failurePayload = {
                durationMs: evt.durationMs,
                error: evt.error,
                jobId: job.id,
                jobName: job.name,
                message: failureMessage,
                nextRunAtMs: evt.nextRunAtMs,
                runAtMs: evt.runAtMs,
                status: evt.status,
              };

              if (failureDest.mode === "webhook" && failureDest.to) {
                const webhookUrl = normalizeHttpWebhookUrl(failureDest.to);
                if (webhookUrl) {
                  void (async () => {
                    await postCronWebhook({
                      blockedLog: "cron: failure destination webhook blocked by SSRF guard",
                      failedLog: "cron: failure destination webhook failed",
                      logContext: { jobId: evt.jobId },
                      logger: cronLogger,
                      payload: failurePayload,
                      webhookToken,
                      webhookUrl,
                    });
                  })();
                } else {
                  cronLogger.warn(
                    {
                      jobId: evt.jobId,
                      webhookUrl: redactWebhookUrl(failureDest.to),
                    },
                    "cron: failure destination webhook URL is invalid, skipping",
                  );
                }
              } else if (failureDest.mode === "announce") {
                const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
                void sendFailureNotificationAnnounce(
                  params.deps,
                  runtimeConfig,
                  agentId,
                  job.id,
                  {
                    accountId: failureDest.accountId,
                    channel: failureDest.channel,
                    sessionKey: job.sessionKey,
                    to: failureDest.to,
                  },
                  `⚠️ ${failureMessage}`,
                );
              }
            } else {
              // No explicit failureDestination — fall back to primary delivery channel (#60608)
              const primaryPlan = resolveCronDeliveryPlan(job);
              if (primaryPlan.mode === "announce" && primaryPlan.requested) {
                const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
                void sendFailureNotificationAnnounce(
                  params.deps,
                  runtimeConfig,
                  agentId,
                  job.id,
                  {
                    accountId: primaryPlan.accountId,
                    channel: primaryPlan.channel,
                    sessionKey: job.sessionKey,
                    to: primaryPlan.to,
                  },
                  `⚠️ ${failureMessage}`,
                );
              }
            }
          }
        }

        const logPath = resolveCronRunLogPath({
          jobId: evt.jobId,
          storePath,
        });
        void appendCronRunLog(
          logPath,
          {
            action: "finished",
            delivered: evt.delivered,
            deliveryError: evt.deliveryError,
            deliveryStatus: evt.deliveryStatus,
            durationMs: evt.durationMs,
            error: evt.error,
            jobId: evt.jobId,
            model: evt.model,
            nextRunAtMs: evt.nextRunAtMs,
            provider: evt.provider,
            runAtMs: evt.runAtMs,
            sessionId: evt.sessionId,
            sessionKey: evt.sessionKey,
            status: evt.status,
            summary: evt.summary,
            ts: Date.now(),
            usage: evt.usage,
          },
          runLogPrune,
        ).catch((error) => {
          cronLogger.warn({ err: String(error), logPath }, "cron: run log append failed");
        });
      }
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({
        agentId,
        reason: opts?.reason,
        sessionKey,
      });
    },
    resolveSessionStorePath,
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      // Merge cron-supplied heartbeat overrides (e.g. target: "last") with the
      // Fully resolved agent heartbeat config so cron-triggered heartbeats
      // Respect agent-specific overrides (agents.list[].heartbeat) before
      // Falling back to agents.defaults.heartbeat.
      const agentEntry =
        Array.isArray(runtimeConfig.agents?.list) &&
        runtimeConfig.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        );
      const agentHeartbeat =
        agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : undefined;
      const baseHeartbeat = {
        ...runtimeConfig.agents?.defaults?.heartbeat,
        ...agentHeartbeat,
      };
      const heartbeatOverride = opts?.heartbeat
        ? { ...baseHeartbeat, ...opts.heartbeat }
        : undefined;
      return await runHeartbeatOnce({
        agentId,
        cfg: runtimeConfig,
        deps: { ...params.deps, runtime: defaultRuntime },
        heartbeat: heartbeatOverride,
        reason: opts?.reason,
        sessionKey,
      });
    },
    runIsolatedAgentJob: async ({ job, message, abortSignal }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      let sessionKey = `cron:${job.id}`;
      if (job.sessionTarget.startsWith("session:")) {
        sessionKey = assertSafeCronSessionTargetId(job.sessionTarget.slice(8));
      }
      try {
        return await runCronIsolatedAgentTurn({
          abortSignal,
          agentId,
          cfg: runtimeConfig,
          deps: params.deps,
          job,
          lane: "cron",
          message,
          sessionKey,
        });
      } finally {
        await cleanupBrowserSessionsForLifecycleEnd({
          onWarn: (msg) => cronLogger.warn({ jobId: job.id }, msg),
          sessionKeys: [sessionKey],
        });
      }
    },
    sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const webhookToken = normalizeOptionalString(params.cfg.cron?.webhookToken);

      // Webhook mode requires a URL - fail closed if missing
      if (mode === "webhook" && !to) {
        cronLogger.warn(
          { jobId: job.id },
          "cron: failure alert webhook mode requires URL, skipping",
        );
        return;
      }

      if (mode === "webhook" && to) {
        const webhookUrl = normalizeHttpWebhookUrl(to);
        if (webhookUrl) {
          await postCronWebhook({
            blockedLog: "cron: failure alert webhook blocked by SSRF guard",
            failedLog: "cron: failure alert webhook failed",
            logContext: { jobId: job.id },
            logger: cronLogger,
            payload: {
              jobId: job.id,
              jobName: job.name,
              message: text,
            },
            webhookToken,
            webhookUrl,
          });
        } else {
          cronLogger.warn(
            {
              jobId: job.id,
              webhookUrl: redactWebhookUrl(to),
            },
            "cron: failure alert webhook URL is invalid, skipping",
          );
        }
        return;
      }

      const target = await resolveDeliveryTarget(runtimeConfig, agentId, {
        accountId,
        channel,
        to,
      });
      if (!target.ok) {
        throw target.error;
      }
      await deliverOutboundPayloads({
        accountId: target.accountId,
        cfg: runtimeConfig,
        channel: target.channel,
        deps: createOutboundSendDeps(params.deps),
        payloads: [{ text }],
        threadId: target.threadId,
        to: target.to,
      });
    },
    sessionStorePath,
    storePath,
  });

  return { cron, cronEnabled, storePath };
}
