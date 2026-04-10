import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  MAX_RECENT_MINUTES,
  MAX_STEER_MESSAGE_CHARS,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  listControlledSubagentRuns,
  resolveControlledSubagentTarget,
  resolveSubagentController,
  steerControlledSubagentRun,
} from "../subagent-control.js";
import {
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
} from "../subagent-list.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SUBAGENT_ACTIONS = ["list", "kill", "steer"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  message: Type.Optional(Type.String()),
  recentMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  target: Type.Optional(Type.String()),
});

export function createSubagentsTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    description:
      "List, kill, or steer spawned sub-agents for this requester session. Use this for sub-agent orchestration.",
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = loadConfig();
      const controller = resolveSubagentController({
        agentSessionKey: opts?.agentSessionKey,
        cfg,
      });
      const runs = listControlledSubagentRuns(controller.controllerSessionKey);
      const recentMinutesRaw = readNumberParam(params, "recentMinutes");
      const recentMinutes = recentMinutesRaw
        ? Math.max(1, Math.min(MAX_RECENT_MINUTES, Math.floor(recentMinutesRaw)))
        : DEFAULT_RECENT_MINUTES;
      const pendingDescendantCount = createPendingDescendantCounter();
      const isActive = (entry: (typeof runs)[number]) =>
        isActiveSubagentRun(entry, pendingDescendantCount);

      if (action === "list") {
        const list = buildSubagentList({
          cfg,
          recentMinutes,
          runs,
        });
        return jsonResult({
          action: "list",
          active: list.active.map(({ line: _line, ...view }) => view),
          callerIsSubagent: controller.callerIsSubagent,
          callerSessionKey: controller.callerSessionKey,
          recent: list.recent.map(({ line: _line, ...view }) => view),
          requesterSessionKey: controller.controllerSessionKey,
          status: "ok",
          text: list.text,
          total: list.total,
        });
      }

      if (action === "kill") {
        const target = readStringParam(params, "target", { required: true });
        if (target === "all" || target === "*") {
          const result = await killAllControlledSubagentRuns({
            cfg,
            controller,
            runs,
          });
          if (result.status === "forbidden") {
            return jsonResult({
              action: "kill",
              error: result.error,
              status: "forbidden",
              target: "all",
            });
          }
          return jsonResult({
            action: "kill",
            killed: result.killed,
            labels: result.labels,
            status: "ok",
            target: "all",
            text:
              result.killed > 0
                ? `killed ${result.killed} subagent${result.killed === 1 ? "" : "s"}.`
                : "no running subagents to kill.",
          });
        }
        const resolved = resolveControlledSubagentTarget(runs, target, {
          isActive,
          recentMinutes,
        });
        if (!resolved.entry) {
          return jsonResult({
            action: "kill",
            error: resolved.error ?? "Unknown subagent target.",
            status: "error",
            target,
          });
        }
        const result = await killControlledSubagentRun({
          cfg,
          controller,
          entry: resolved.entry,
        });
        return jsonResult({
          action: "kill",
          cascadeKilled: "cascadeKilled" in result ? result.cascadeKilled : undefined,
          cascadeLabels: "cascadeLabels" in result ? result.cascadeLabels : undefined,
          error: "error" in result ? result.error : undefined,
          label: result.label,
          runId: result.runId,
          sessionKey: result.sessionKey,
          status: result.status,
          target,
          text: result.text,
        });
      }

      if (action === "steer") {
        const target = readStringParam(params, "target", { required: true });
        const message = readStringParam(params, "message", { required: true });
        if (message.length > MAX_STEER_MESSAGE_CHARS) {
          return jsonResult({
            action: "steer",
            error: `Message too long (${message.length} chars, max ${MAX_STEER_MESSAGE_CHARS}).`,
            status: "error",
            target,
          });
        }
        const resolved = resolveControlledSubagentTarget(runs, target, {
          isActive,
          recentMinutes,
        });
        if (!resolved.entry) {
          return jsonResult({
            action: "steer",
            error: resolved.error ?? "Unknown subagent target.",
            status: "error",
            target,
          });
        }
        const result = await steerControlledSubagentRun({
          cfg,
          controller,
          entry: resolved.entry,
          message,
        });
        return jsonResult({
          action: "steer",
          error: "error" in result ? result.error : undefined,
          label: "label" in result ? result.label : undefined,
          mode: "mode" in result ? result.mode : undefined,
          runId: result.runId,
          sessionId: result.sessionId,
          sessionKey: result.sessionKey,
          status: result.status,
          target,
          text: result.text,
        });
      }

      return jsonResult({
        error: "Unsupported action.",
        status: "error",
      });
    },
    label: "Subagents",
    name: "subagents",
    parameters: SubagentsToolSchema,
  };
}
