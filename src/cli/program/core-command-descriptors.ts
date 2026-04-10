import { defineCommandDescriptorCatalog } from "./command-descriptor-utils.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

export type CoreCliCommandDescriptor = NamedCommandDescriptor;

const coreCliCommandCatalog = defineCommandDescriptorCatalog([
  {
    description: "Initialize local config and agent workspace",
    hasSubcommands: false,
    name: "setup",
  },
  {
    description: "Interactive onboarding for gateway, workspace, and skills",
    hasSubcommands: false,
    name: "onboard",
  },
  {
    description: "Interactive configuration for credentials, channels, gateway, and agent defaults",
    hasSubcommands: false,
    name: "configure",
  },
  {
    description:
      "Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup.",
    hasSubcommands: true,
    name: "config",
  },
  {
    description: "Create and verify local backup archives for OpenClaw state",
    hasSubcommands: true,
    name: "backup",
  },
  {
    description: "Health checks + quick fixes for the gateway and channels",
    hasSubcommands: false,
    name: "doctor",
  },
  {
    description: "Open the Control UI with your current token",
    hasSubcommands: false,
    name: "dashboard",
  },
  {
    description: "Reset local config/state (keeps the CLI installed)",
    hasSubcommands: false,
    name: "reset",
  },
  {
    description: "Uninstall the gateway service + local data (CLI remains)",
    hasSubcommands: false,
    name: "uninstall",
  },
  {
    description: "Send, read, and manage messages",
    hasSubcommands: true,
    name: "message",
  },
  {
    description: "Manage OpenClaw MCP config and channel bridge",
    hasSubcommands: true,
    name: "mcp",
  },
  {
    description: "Run one agent turn via the Gateway",
    hasSubcommands: false,
    name: "agent",
  },
  {
    description: "Manage isolated agents (workspaces, auth, routing)",
    hasSubcommands: true,
    name: "agents",
  },
  {
    description: "Show channel health and recent session recipients",
    hasSubcommands: false,
    name: "status",
  },
  {
    description: "Fetch health from the running gateway",
    hasSubcommands: false,
    name: "health",
  },
  {
    description: "List stored conversation sessions",
    hasSubcommands: true,
    name: "sessions",
  },
  {
    description: "Inspect durable background task state",
    hasSubcommands: true,
    name: "tasks",
  },
] as const satisfies readonly CoreCliCommandDescriptor[]);

export const CORE_CLI_COMMAND_DESCRIPTORS = coreCliCommandCatalog.descriptors;

export function getCoreCliCommandDescriptors(): readonly CoreCliCommandDescriptor[] {
  return coreCliCommandCatalog.getDescriptors();
}

export function getCoreCliCommandNames(): string[] {
  return coreCliCommandCatalog.getNames();
}

export function getCoreCliCommandsWithSubcommands(): string[] {
  return coreCliCommandCatalog.getCommandsWithSubcommands();
}
