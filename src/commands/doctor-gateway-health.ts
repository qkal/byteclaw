import type { OpenClawConfig } from "../config/config.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import type { DoctorMemoryStatusPayload } from "../gateway/server-methods/doctor.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";

export interface GatewayMemoryProbe {
  checked: boolean;
  ready: boolean;
  error?: string;
}

export async function checkGatewayHealth(params: {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  timeoutMs?: number;
}) {
  const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
  let healthOk = false;
  try {
    await healthCommand({ config: params.cfg, json: false, timeoutMs }, params.runtime);
    healthOk = true;
  } catch (error) {
    const message = String(error);
    if (message.includes("gateway closed")) {
      note("Gateway not running.", "Gateway");
      note(gatewayDetails.message, "Gateway connection");
    } else {
      params.runtime.error(formatHealthCheckFailure(error));
    }
  }

  if (healthOk) {
    try {
      const status = await callGateway({
        method: "channels.status",
        params: { probe: true, timeoutMs: 5000 },
        timeoutMs: 6000,
      });
      const issues = collectChannelStatusIssues(status);
      if (issues.length > 0) {
        note(
          issues
            .map(
              (issue) =>
                `- ${issue.channel} ${issue.accountId}: ${issue.message}${
                  issue.fix ? ` (${issue.fix})` : ""
                }`,
            )
            .join("\n"),
          "Channel warnings",
        );
      }
    } catch {
      // Ignore: doctor already reported gateway health
    }
  }

  return { healthOk };
}

export async function probeGatewayMemoryStatus(params: {
  cfg: OpenClawConfig;
  timeoutMs?: number;
}): Promise<GatewayMemoryProbe> {
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 8000;
  try {
    const payload = await callGateway<DoctorMemoryStatusPayload>({
      config: params.cfg,
      method: "doctor.memory.status",
      timeoutMs,
    });
    return {
      checked: true,
      error: payload.embedding.error,
      ready: payload.embedding.ok,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    return {
      checked: true,
      error: `gateway memory probe unavailable: ${message}`,
      ready: false,
    };
  }
}
