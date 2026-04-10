import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { getChatCommands } from "../auto-reply/commands-registry.data.js";

const BASE_AVAILABLE_COMMANDS: AvailableCommand[] = [
  { description: "Show help and common commands.", name: "help" },
  { description: "List available commands.", name: "commands" },
  { description: "Show current status.", name: "status" },
  {
    description: "Explain context usage (list|detail|json).",
    input: { hint: "list | detail | json" },
    name: "context",
  },
  { description: "Show sender id (alias: /id).", name: "whoami" },
  { description: "Alias for /whoami.", name: "id" },
  { description: "List or manage sub-agents.", name: "subagents" },
  { description: "Read or write config (owner-only).", name: "config" },
  { description: "Set runtime-only overrides (owner-only).", name: "debug" },
  { description: "Toggle usage footer (off|tokens|full).", name: "usage" },
  { description: "Stop the current run.", name: "stop" },
  { description: "Restart the gateway (if enabled).", name: "restart" },
  { description: "Set group activation (mention|always).", name: "activation" },
  { description: "Set send mode (on|off|inherit).", name: "send" },
  { description: "Reset the session (/new).", name: "reset" },
  { description: "Reset the session (/reset).", name: "new" },
  {
    description: "Set thinking level (off|minimal|low|medium|high|xhigh).",
    name: "think",
  },
  { description: "Set verbose mode (on|full|off).", name: "verbose" },
  { description: "Toggle reasoning output (on|off|stream).", name: "reasoning" },
  { description: "Toggle elevated mode (on|off).", name: "elevated" },
  { description: "Select a model (list|status|<name>).", name: "model" },
  { description: "Adjust queue mode and options.", name: "queue" },
  { description: "Run a host command (if enabled).", name: "bash" },
  { description: "Compact the session history.", name: "compact" },
];

function listDockAvailableCommands(): AvailableCommand[] {
  return getChatCommands()
    .filter((command) => command.key.startsWith("dock:"))
    .map((command) => ({
      description: command.description,
      name: command.textAliases[0]?.replace(/^\//, "").trim() || command.key,
    }));
}

export function getAvailableCommands(): AvailableCommand[] {
  return [...BASE_AVAILABLE_COMMANDS, ...listDockAvailableCommands()];
}
