import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";

export type DebugCommand =
  | { action: "show" }
  | { action: "reset" }
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

export function parseDebugCommand(raw: string): DebugCommand | null {
  return parseStandardSetUnsetSlashCommand<DebugCommand>({
    invalidMessage: "Invalid /debug syntax.",
    onKnownAction: (action) => {
      if (action === "show") {
        return { action: "show" };
      }
      if (action === "reset") {
        return { action: "reset" };
      }
      return undefined;
    },
    raw,
    slash: "/debug",
    usageMessage: "Usage: /debug show|set|unset|reset",
  });
}
