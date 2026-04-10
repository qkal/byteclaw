import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    description:
      "End your current turn. Use after spawning subagents to receive their results as the next message.",
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message") || "Turn yielded.";
      if (!opts?.sessionId) {
        return jsonResult({ error: "No session context", status: "error" });
      }
      if (!opts?.onYield) {
        return jsonResult({ error: "Yield not supported in this context", status: "error" });
      }
      await opts.onYield(message);
      return jsonResult({ message, status: "yielded" });
    },
    label: "Yield",
    name: "sessions_yield",
    parameters: SessionsYieldToolSchema,
  };
}
