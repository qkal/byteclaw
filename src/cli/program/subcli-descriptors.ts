import { defineCommandDescriptorCatalog } from "./command-descriptor-utils.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

export type SubCliDescriptor = NamedCommandDescriptor;

const subCliCommandCatalog = defineCommandDescriptorCatalog([
  { description: "Agent Control Protocol tools", hasSubcommands: true, name: "acp" },
  {
    description: "Run, inspect, and query the WebSocket Gateway",
    hasSubcommands: true,
    name: "gateway",
  },
  { description: "Gateway service (legacy alias)", hasSubcommands: true, name: "daemon" },
  { description: "Tail gateway file logs via RPC", hasSubcommands: false, name: "logs" },
  {
    description: "System events, heartbeat, and presence",
    hasSubcommands: true,
    name: "system",
  },
  {
    description: "Discover, scan, and configure models",
    hasSubcommands: true,
    name: "models",
  },
  {
    description: "Run provider-backed inference commands",
    hasSubcommands: true,
    name: "infer",
  },
  {
    description: "Run provider-backed inference commands (fallback alias: infer)",
    hasSubcommands: true,
    name: "capability",
  },
  {
    description: "Manage exec approvals (gateway or node host)",
    hasSubcommands: true,
    name: "approvals",
  },
  {
    description: "Show or synchronize requested exec policy with host approvals",
    hasSubcommands: true,
    name: "exec-policy",
  },
  {
    description: "Manage gateway-owned node pairing and node commands",
    hasSubcommands: true,
    name: "nodes",
  },
  {
    description: "Device pairing + token management",
    hasSubcommands: true,
    name: "devices",
  },
  {
    description: "Run and manage the headless node host service",
    hasSubcommands: true,
    name: "node",
  },
  {
    description: "Manage sandbox containers for agent isolation",
    hasSubcommands: true,
    name: "sandbox",
  },
  {
    description: "Open a terminal UI connected to the Gateway",
    hasSubcommands: false,
    name: "tui",
  },
  {
    description: "Manage cron jobs via the Gateway scheduler",
    hasSubcommands: true,
    name: "cron",
  },
  {
    description: "DNS helpers for wide-area discovery (Tailscale + CoreDNS)",
    hasSubcommands: true,
    name: "dns",
  },
  {
    description: "Search the live OpenClaw docs",
    hasSubcommands: false,
    name: "docs",
  },
  {
    description: "Run QA scenarios and launch the private QA debugger UI",
    hasSubcommands: true,
    name: "qa",
  },
  {
    description: "Manage internal agent hooks",
    hasSubcommands: true,
    name: "hooks",
  },
  {
    description: "Webhook helpers and integrations",
    hasSubcommands: true,
    name: "webhooks",
  },
  {
    description: "Generate mobile pairing QR/setup code",
    hasSubcommands: false,
    name: "qr",
  },
  {
    description: "Legacy clawbot command aliases",
    hasSubcommands: true,
    name: "clawbot",
  },
  {
    description: "Secure DM pairing (approve inbound requests)",
    hasSubcommands: true,
    name: "pairing",
  },
  {
    description: "Manage OpenClaw plugins and extensions",
    hasSubcommands: true,
    name: "plugins",
  },
  {
    description: "Manage connected chat channels (Telegram, Discord, etc.)",
    hasSubcommands: true,
    name: "channels",
  },
  {
    description: "Lookup contact and group IDs (self, peers, groups) for supported chat channels",
    hasSubcommands: true,
    name: "directory",
  },
  {
    description: "Security tools and local config audits",
    hasSubcommands: true,
    name: "security",
  },
  {
    description: "Secrets runtime reload controls",
    hasSubcommands: true,
    name: "secrets",
  },
  {
    description: "List and inspect available skills",
    hasSubcommands: true,
    name: "skills",
  },
  {
    description: "Update OpenClaw and inspect update channel status",
    hasSubcommands: true,
    name: "update",
  },
  {
    description: "Generate shell completion script",
    hasSubcommands: false,
    name: "completion",
  },
] as const satisfies readonly SubCliDescriptor[]);

export const SUB_CLI_DESCRIPTORS = subCliCommandCatalog.descriptors;

export function getSubCliEntries(): readonly SubCliDescriptor[] {
  return subCliCommandCatalog.getDescriptors();
}

export function getSubCliCommandsWithSubcommands(): string[] {
  return subCliCommandCatalog.getCommandsWithSubcommands();
}
