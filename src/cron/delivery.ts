import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getChildLogger } from "../logging.js";
import {
  type CronDeliveryPlan,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
  resolveCronDeliveryPlan,
  resolveFailureDestination,
} from "./delivery-plan.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import type { CronMessageChannel } from "./types.js";

export {
  resolveCronDeliveryPlan,
  resolveFailureDestination,
  type CronDeliveryPlan,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
};

const FAILURE_NOTIFICATION_TIMEOUT_MS = 30_000;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });

export async function sendFailureNotificationAnnounce(
  deps: CliDeps,
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
  target: { channel?: string; to?: string; accountId?: string; sessionKey?: string },
  message: string,
): Promise<void> {
  const resolvedTarget = await resolveDeliveryTarget(cfg, agentId, {
    accountId: target.accountId,
    channel: target.channel as CronMessageChannel | undefined,
    sessionKey: target.sessionKey,
    to: target.to,
  });

  if (!resolvedTarget.ok) {
    cronDeliveryLogger.warn(
      { error: resolvedTarget.error.message },
      "cron: failed to resolve failure destination target",
    );
    return;
  }

  const identity = resolveAgentOutboundIdentity(cfg, agentId);
  const session = buildOutboundSessionContext({
    agentId,
    cfg,
    sessionKey: `cron:${jobId}:failure`,
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, FAILURE_NOTIFICATION_TIMEOUT_MS);

  try {
    await deliverOutboundPayloads({
      abortSignal: abortController.signal,
      accountId: resolvedTarget.accountId,
      bestEffort: false,
      cfg,
      channel: resolvedTarget.channel,
      deps: createOutboundSendDeps(deps),
      identity,
      payloads: [{ text: message }],
      session,
      threadId: resolvedTarget.threadId,
      to: resolvedTarget.to,
    });
  } catch (error) {
    cronDeliveryLogger.warn(
      {
        channel: resolvedTarget.channel,
        err: formatErrorMessage(error),
        to: resolvedTarget.to,
      },
      "cron: failure destination announce failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}
