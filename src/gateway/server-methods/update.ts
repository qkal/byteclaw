import { loadConfig } from "../../config/config.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import {
  type RestartSentinelPayload,
  formatDoctorNonInteractiveHint,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { validateUpdateRunParams } from "../protocol/index.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const updateHandlers: GatewayRequestHandlers = {
  "update.run": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);
    const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.floor(timeoutMsRaw))
        : undefined;

    let result: Awaited<ReturnType<typeof runGatewayUpdate>>;
    try {
      const config = loadConfig();
      const configChannel = normalizeUpdateChannel(config.update?.channel);
      const root =
        (await resolveOpenClawPackageRoot({
          argv1: process.argv[1],
          cwd: process.cwd(),
          moduleUrl: import.meta.url,
        })) ?? process.cwd();
      result = await runGatewayUpdate({
        argv1: process.argv[1],
        channel: configChannel ?? undefined,
        cwd: root,
        timeoutMs,
      });
    } catch (error) {
      result = {
        durationMs: 0,
        mode: "unknown",
        reason: String(error),
        status: "error",
        steps: [],
      };
    }

    const payload: RestartSentinelPayload = {
      deliveryContext,
      doctorHint: formatDoctorNonInteractiveHint(),
      kind: "update",
      message: note ?? null,
      sessionKey,
      stats: {
        after: result.after ?? null,
        before: result.before ?? null,
        durationMs: result.durationMs,
        mode: result.mode,
        reason: result.reason ?? null,
        root: result.root ?? undefined,
        steps: result.steps.map((step) => ({
          command: step.command,
          cwd: step.cwd,
          durationMs: step.durationMs,
          log: {
            exitCode: step.exitCode ?? null,
            stderrTail: step.stderrTail ?? null,
            stdoutTail: step.stdoutTail ?? null,
          },
          name: step.name,
        })),
      },
      status: result.status,
      threadId,
      ts: Date.now(),
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    // Only restart the gateway when the update actually succeeded.
    // Restarting after a failed update leaves the process in a broken state
    // (corrupted node_modules, partial builds) and causes a crash loop.
    const restart =
      result.status === "ok"
        ? scheduleGatewaySigusr1Restart({
            audit: {
              actor: actor.actor,
              changedPaths: [],
              clientIp: actor.clientIp,
              deviceId: actor.deviceId,
            },
            delayMs: restartDelayMs,
            reason: "update.run",
          })
        : null;
    context?.logGateway?.info(
      `update.run completed ${formatControlPlaneActor(actor)} changedPaths=<n/a> restartReason=update.run status=${result.status}`,
    );
    if (restart?.coalesced) {
      context?.logGateway?.warn(
        `update.run restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }

    respond(
      true,
      {
        ok: result.status !== "error",
        restart,
        result,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
