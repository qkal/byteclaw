import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";

export type McpCommand =
  | { action: "show"; name?: string }
  | { action: "set"; name: string; value: unknown }
  | { action: "unset"; name: string }
  | { action: "error"; message: string };

export function parseMcpCommand(raw: string): McpCommand | null {
  return parseStandardSetUnsetSlashCommand<McpCommand>({
    invalidMessage: "Invalid /mcp syntax.",
    onKnownAction: (action, args) => {
      if (action === "show" || action === "get") {
        return { action: "show", name: args || undefined };
      }
      return undefined;
    },
    onSet: (name, value) => ({ action: "set", name, value }),
    onUnset: (name) => ({ action: "unset", name }),
    raw,
    slash: "/mcp",
    usageMessage: "Usage: /mcp show|set|unset",
  });
}
