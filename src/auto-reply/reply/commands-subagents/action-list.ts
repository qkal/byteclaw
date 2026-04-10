import { buildSubagentList } from "../../../agents/subagent-list.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { RECENT_WINDOW_MINUTES, type SubagentsCommandContext, stopWithText } from "./shared.js";

export function handleSubagentsListAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, runs } = ctx;
  const list = buildSubagentList({
    cfg: params.cfg,
    recentMinutes: RECENT_WINDOW_MINUTES,
    runs,
    taskMaxChars: 110,
  });
  const lines = ["active subagents:", "-----"];
  if (list.active.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(list.active.map((entry) => entry.line).join("\n"));
  }
  lines.push("", `recent subagents (last ${RECENT_WINDOW_MINUTES}m):`, "-----");
  if (list.recent.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(list.recent.map((entry) => entry.line).join("\n"));
  }

  return stopWithText(lines.join("\n"));
}
