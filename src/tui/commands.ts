import type { SlashCommand } from "@mariozechner/pi-tui";
import { listChatCommands, listChatCommandsForConfig } from "../auto-reply/commands-registry.js";
import { formatThinkingLevels, listThinkingLevelLabels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const VERBOSE_LEVELS = ["on", "off"];
const FAST_LEVELS = ["status", "on", "off"];
const REASONING_LEVELS = ["on", "off"];
const ELEVATED_LEVELS = ["on", "off", "ask", "full"];
const ACTIVATION_LEVELS = ["mention", "always"];
const USAGE_FOOTER_LEVELS = ["off", "tokens", "full"];

export interface ParsedCommand {
  name: string;
  args: string;
}

export interface SlashCommandOptions {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
}

const COMMAND_ALIASES: Record<string, string> = {
  elev: "elevated",
  gwstatus: "gateway-status",
};

function createLevelCompletion(
  levels: string[],
): NonNullable<SlashCommand["getArgumentCompletions"]> {
  return (prefix) =>
    levels
      .filter((value) => value.startsWith(normalizeLowercaseStringOrEmpty(prefix)))
      .map((value) => ({
        label: value,
        value,
      }));
}

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.replace(/^\//, "").trim();
  if (!trimmed) {
    return { args: "", name: "" };
  }
  const [name, ...rest] = trimmed.split(/\s+/);
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return {
    args: rest.join(" ").trim(),
    name: COMMAND_ALIASES[normalized] ?? normalized,
  };
}

export function getSlashCommands(options: SlashCommandOptions = {}): SlashCommand[] {
  const thinkLevels = listThinkingLevelLabels(options.provider, options.model);
  const verboseCompletions = createLevelCompletion(VERBOSE_LEVELS);
  const fastCompletions = createLevelCompletion(FAST_LEVELS);
  const reasoningCompletions = createLevelCompletion(REASONING_LEVELS);
  const usageCompletions = createLevelCompletion(USAGE_FOOTER_LEVELS);
  const elevatedCompletions = createLevelCompletion(ELEVATED_LEVELS);
  const activationCompletions = createLevelCompletion(ACTIVATION_LEVELS);
  const commands: SlashCommand[] = [
    { description: "Show slash command help", name: "help" },
    { description: "Show gateway status summary", name: "gateway-status" },
    { description: "Alias for /gateway-status", name: "gwstatus" },
    { description: "Switch agent (or open picker)", name: "agent" },
    { description: "Open agent picker", name: "agents" },
    { description: "Switch session (or open picker)", name: "session" },
    { description: "Open session picker", name: "sessions" },
    {
      description: "Set model (or open picker)",
      name: "model",
    },
    { description: "Open model picker", name: "models" },
    {
      description: "Set thinking level",
      getArgumentCompletions: (prefix) =>
        thinkLevels
          .filter((v) => v.startsWith(normalizeLowercaseStringOrEmpty(prefix)))
          .map((value) => ({ label: value, value })),
      name: "think",
    },
    {
      description: "Set fast mode on/off",
      getArgumentCompletions: fastCompletions,
      name: "fast",
    },
    {
      description: "Set verbose on/off",
      getArgumentCompletions: verboseCompletions,
      name: "verbose",
    },
    {
      description: "Set reasoning on/off",
      getArgumentCompletions: reasoningCompletions,
      name: "reasoning",
    },
    {
      description: "Toggle per-response usage line",
      getArgumentCompletions: usageCompletions,
      name: "usage",
    },
    {
      description: "Set elevated on/off/ask/full",
      getArgumentCompletions: elevatedCompletions,
      name: "elevated",
    },
    {
      description: "Alias for /elevated",
      getArgumentCompletions: elevatedCompletions,
      name: "elev",
    },
    {
      description: "Set group activation",
      getArgumentCompletions: activationCompletions,
      name: "activation",
    },
    { description: "Abort active run", name: "abort" },
    { description: "Reset the session", name: "new" },
    { description: "Reset the session", name: "reset" },
    { description: "Open settings", name: "settings" },
    { description: "Exit the TUI", name: "exit" },
    { description: "Exit the TUI", name: "quit" },
  ];

  const seen = new Set(commands.map((command) => command.name));
  const gatewayCommands = options.cfg ? listChatCommandsForConfig(options.cfg) : listChatCommands();
  for (const command of gatewayCommands) {
    const aliases = command.textAliases.length > 0 ? command.textAliases : [`/${command.key}`];
    for (const alias of aliases) {
      const name = alias.replace(/^\//, "").trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      commands.push({ description: command.description, name });
    }
  }

  return commands;
}

export function helpText(options: SlashCommandOptions = {}): string {
  const thinkLevels = formatThinkingLevels(options.provider, options.model, "|");
  return [
    "Slash commands:",
    "/help",
    "/commands",
    "/status",
    "/gateway-status",
    "/gwstatus",
    "/agent <id> (or /agents)",
    "/session <key> (or /sessions)",
    "/model <provider/model> (or /models)",
    `/think <${thinkLevels}>`,
    "/fast <status|on|off>",
    "/verbose <on|off>",
    "/reasoning <on|off>",
    "/usage <off|tokens|full>",
    "/elevated <on|off|ask|full>",
    "/elev <on|off|ask|full>",
    "/activation <mention|always>",
    "/new or /reset",
    "/abort",
    "/settings",
    "/exit",
  ].join("\n");
}
