import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import type {
  ChatCommandDefinition,
  CommandCategory,
  CommandScope,
} from "./commands-registry.types.js";
import { listThinkingLevels } from "./thinking.js";

interface DefineChatCommandInput {
  key: string;
  nativeName?: string;
  description: string;
  args?: ChatCommandDefinition["args"];
  argsParsing?: ChatCommandDefinition["argsParsing"];
  formatArgs?: ChatCommandDefinition["formatArgs"];
  argsMenu?: ChatCommandDefinition["argsMenu"];
  acceptsArgs?: boolean;
  textAlias?: string;
  textAliases?: string[];
  scope?: CommandScope;
  category?: CommandCategory;
}

export function defineChatCommand(command: DefineChatCommandInput): ChatCommandDefinition {
  const aliases = (command.textAliases ?? (command.textAlias ? [command.textAlias] : []))
    .map((alias) => alias.trim())
    .filter(Boolean);
  const scope =
    command.scope ?? (command.nativeName ? (aliases.length ? "both" : "native") : "text");
  const acceptsArgs = command.acceptsArgs ?? Boolean(command.args?.length);
  const argsParsing = command.argsParsing ?? (command.args?.length ? "positional" : "none");
  return {
    acceptsArgs,
    args: command.args,
    argsMenu: command.argsMenu,
    argsParsing,
    category: command.category,
    description: command.description,
    formatArgs: command.formatArgs,
    key: command.key,
    nativeName: command.nativeName,
    scope,
    textAliases: aliases,
  };
}

export function registerAlias(
  commands: ChatCommandDefinition[],
  key: string,
  ...aliases: string[]
): void {
  const command = commands.find((entry) => entry.key === key);
  if (!command) {
    throw new Error(`registerAlias: unknown command key: ${key}`);
  }
  const existing = new Set(
    command.textAliases
      .map((alias) => normalizeOptionalLowercaseString(alias))
      .filter((alias): alias is string => Boolean(alias)),
  );
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = normalizeOptionalLowercaseString(trimmed);
    if (!lowered) {
      continue;
    }
    if (existing.has(lowered)) {
      continue;
    }
    existing.add(lowered);
    command.textAliases.push(trimmed);
  }
}

export function assertCommandRegistry(commands: ChatCommandDefinition[]): void {
  const keys = new Set<string>();
  const nativeNames = new Set<string>();
  const textAliases = new Set<string>();
  for (const command of commands) {
    if (keys.has(command.key)) {
      throw new Error(`Duplicate command key: ${command.key}`);
    }
    keys.add(command.key);

    const nativeName = command.nativeName?.trim();
    if (command.scope === "text") {
      if (nativeName) {
        throw new Error(`Text-only command has native name: ${command.key}`);
      }
      if (command.textAliases.length === 0) {
        throw new Error(`Text-only command missing text alias: ${command.key}`);
      }
    } else if (!nativeName) {
      throw new Error(`Native command missing native name: ${command.key}`);
    } else {
      const nativeKey = normalizeOptionalLowercaseString(nativeName) ?? "";
      if (nativeNames.has(nativeKey)) {
        throw new Error(`Duplicate native command: ${nativeName}`);
      }
      nativeNames.add(nativeKey);
    }

    if (command.scope === "native" && command.textAliases.length > 0) {
      throw new Error(`Native-only command has text aliases: ${command.key}`);
    }

    for (const alias of command.textAliases) {
      if (!alias.startsWith("/")) {
        throw new Error(`Command alias missing leading '/': ${alias}`);
      }
      const aliasKey = normalizeOptionalLowercaseString(alias) ?? "";
      if (textAliases.has(aliasKey)) {
        throw new Error(`Duplicate command alias: ${alias}`);
      }
      textAliases.add(aliasKey);
    }
  }
}

export function buildBuiltinChatCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    defineChatCommand({
      category: "status",
      description: "Show available commands.",
      key: "help",
      nativeName: "help",
      textAlias: "/help",
    }),
    defineChatCommand({
      category: "status",
      description: "List all slash commands.",
      key: "commands",
      nativeName: "commands",
      textAlias: "/commands",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["compact", "verbose"],
          description: "compact or verbose",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "status",
      description: "List available runtime tools.",
      key: "tools",
      nativeName: "tools",
      textAlias: "/tools",
    }),
    defineChatCommand({
      args: [
        {
          description: "Skill name",
          name: "name",
          required: true,
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Skill input",
          name: "input",
          type: "string",
        },
      ],
      category: "tools",
      description: "Run a skill by name.",
      key: "skill",
      nativeName: "skill",
      textAlias: "/skill",
    }),
    defineChatCommand({
      category: "status",
      description: "Show current status.",
      key: "status",
      nativeName: "status",
      textAlias: "/status",
    }),
    defineChatCommand({
      category: "status",
      description: "List background tasks for this session.",
      key: "tasks",
      nativeName: "tasks",
      textAlias: "/tasks",
    }),
    defineChatCommand({
      acceptsArgs: true,
      category: "management",
      description: "List/add/remove allowlist entries.",
      key: "allowlist",
      scope: "text",
      textAlias: "/allowlist",
    }),
    defineChatCommand({
      acceptsArgs: true,
      category: "management",
      description: "Approve or deny exec requests.",
      key: "approve",
      nativeName: "approve",
      textAlias: "/approve",
    }),
    defineChatCommand({
      acceptsArgs: true,
      category: "status",
      description: "Explain how context is built and used.",
      key: "context",
      nativeName: "context",
      textAlias: "/context",
    }),
    defineChatCommand({
      acceptsArgs: true,
      category: "tools",
      description: "Ask a side question without changing future session context.",
      key: "btw",
      nativeName: "btw",
      textAlias: "/btw",
    }),
    defineChatCommand({
      acceptsArgs: true,
      args: [
        {
          description: "Output path (default: workspace)",
          name: "path",
          required: false,
          type: "string",
        },
      ],
      category: "status",
      description: "Export current session to HTML file with full system prompt.",
      key: "export-session",
      nativeName: "export-session",
      textAliases: ["/export-session", "/export"],
    }),
    defineChatCommand({
      args: [
        {
          choices: [
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
            { value: "status", label: "Status" },
            { value: "provider", label: "Provider" },
            { value: "limit", label: "Limit" },
            { value: "summary", label: "Summary" },
            { value: "audio", label: "Audio" },
            { value: "help", label: "Help" },
          ],
          description: "TTS action",
          name: "action",
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Provider, limit, or text",
          name: "value",
          type: "string",
        },
      ],
      argsMenu: {
        arg: "action",
        title:
          "TTS Actions:\n" +
          "• On – Enable TTS for responses\n" +
          "• Off – Disable TTS\n" +
          "• Status – Show current settings\n" +
          "• Provider – Show or set the voice provider\n" +
          "• Limit – Set max characters for TTS\n" +
          "• Summary – Toggle AI summary for long texts\n" +
          "• Audio – Generate TTS from custom text\n" +
          "• Help – Show usage guide",
      },
      category: "media",
      description: "Control text-to-speech (TTS).",
      key: "tts",
      nativeName: "tts",
      textAlias: "/tts",
    }),
    defineChatCommand({
      category: "status",
      description: "Show your sender id.",
      key: "whoami",
      nativeName: "whoami",
      textAlias: "/whoami",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["idle", "max-age"],
          description: "idle | max-age",
          name: "action",
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Duration (24h, 90m) or off",
          name: "value",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "session",
      description: "Manage session-level settings (for example /session idle).",
      key: "session",
      nativeName: "session",
      textAlias: "/session",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["list", "kill", "log", "info", "send", "steer", "spawn"],
          description: "list | kill | log | info | send | steer | spawn",
          name: "action",
          type: "string",
        },
        {
          description: "Run id, index, or session key",
          name: "target",
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Additional input (limit/message)",
          name: "value",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "management",
      description: "List, kill, log, spawn, or steer subagent runs for this session.",
      key: "subagents",
      nativeName: "subagents",
      textAlias: "/subagents",
    }),
    defineChatCommand({
      args: [
        {
          choices: [
            "spawn",
            "cancel",
            "steer",
            "close",
            "sessions",
            "status",
            "set-mode",
            "set",
            "cwd",
            "permissions",
            "timeout",
            "model",
            "reset-options",
            "doctor",
            "install",
            "help",
          ],
          description: "Action to run",
          name: "action",
          preferAutocomplete: true,
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Action arguments",
          name: "value",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "management",
      description: "Manage ACP sessions and runtime options.",
      key: "acp",
      nativeName: "acp",
      textAlias: "/acp",
    }),
    defineChatCommand({
      args: [
        {
          captureRemaining: true,
          description: "Subagent label/index or session key/id/label",
          name: "target",
          type: "string",
        },
      ],
      category: "management",
      description:
        "Bind this thread (Discord) or topic/conversation (Telegram) to a session target.",
      key: "focus",
      nativeName: "focus",
      textAlias: "/focus",
    }),
    defineChatCommand({
      category: "management",
      description: "Remove the current thread (Discord) or topic/conversation (Telegram) binding.",
      key: "unfocus",
      nativeName: "unfocus",
      textAlias: "/unfocus",
    }),
    defineChatCommand({
      category: "management",
      description: "List thread-bound agents for this session.",
      key: "agents",
      nativeName: "agents",
      textAlias: "/agents",
    }),
    defineChatCommand({
      args: [
        {
          description: "Label, run id, index, or all",
          name: "target",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "management",
      description: "Kill a running subagent (or all).",
      key: "kill",
      nativeName: "kill",
      textAlias: "/kill",
    }),
    defineChatCommand({
      args: [
        {
          description: "Label, run id, or index",
          name: "target",
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Steering message",
          name: "message",
          type: "string",
        },
      ],
      category: "management",
      description: "Send guidance to a running subagent.",
      key: "steer",
      nativeName: "steer",
      textAlias: "/steer",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["show", "get", "set", "unset"],
          description: "show | get | set | unset",
          name: "action",
          type: "string",
        },
        {
          description: "Config path",
          name: "path",
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Value for set",
          name: "value",
          type: "string",
        },
      ],
      argsParsing: "none",
      category: "management",
      description: "Show or set config values.",
      formatArgs: COMMAND_ARG_FORMATTERS.config,
      key: "config",
      nativeName: "config",
      textAlias: "/config",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["show", "get", "set", "unset"],
          description: "show | get | set | unset",
          name: "action",
          type: "string",
        },
        {
          description: "MCP server name",
          name: "path",
          type: "string",
        },
        {
          captureRemaining: true,
          description: "JSON config for set",
          name: "value",
          type: "string",
        },
      ],
      argsParsing: "none",
      category: "management",
      description: "Show or set OpenClaw MCP servers.",
      formatArgs: COMMAND_ARG_FORMATTERS.mcp,
      key: "mcp",
      nativeName: "mcp",
      textAlias: "/mcp",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["list", "show", "get", "enable", "disable"],
          description: "list | show | get | enable | disable",
          name: "action",
          type: "string",
        },
        {
          description: "Plugin id or name",
          name: "path",
          type: "string",
        },
      ],
      argsParsing: "none",
      category: "management",
      description: "List, show, enable, or disable plugins.",
      formatArgs: COMMAND_ARG_FORMATTERS.plugins,
      key: "plugins",
      nativeName: "plugins",
      textAliases: ["/plugins", "/plugin"],
    }),
    defineChatCommand({
      args: [
        {
          choices: ["show", "reset", "set", "unset"],
          description: "show | reset | set | unset",
          name: "action",
          type: "string",
        },
        {
          description: "Debug path",
          name: "path",
          type: "string",
        },
        {
          captureRemaining: true,
          description: "Value for set",
          name: "value",
          type: "string",
        },
      ],
      argsParsing: "none",
      category: "management",
      description: "Set runtime debug overrides.",
      formatArgs: COMMAND_ARG_FORMATTERS.debug,
      key: "debug",
      nativeName: "debug",
      textAlias: "/debug",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["off", "tokens", "full", "cost"],
          description: "off, tokens, full, or cost",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "options",
      description: "Usage footer or cost summary.",
      key: "usage",
      nativeName: "usage",
      textAlias: "/usage",
    }),
    defineChatCommand({
      category: "session",
      description: "Stop the current run.",
      key: "stop",
      nativeName: "stop",
      textAlias: "/stop",
    }),
    defineChatCommand({
      category: "tools",
      description: "Restart OpenClaw.",
      key: "restart",
      nativeName: "restart",
      textAlias: "/restart",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["mention", "always"],
          description: "mention or always",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "management",
      description: "Set group activation mode.",
      key: "activation",
      nativeName: "activation",
      textAlias: "/activation",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["on", "off", "inherit"],
          description: "on, off, or inherit",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "management",
      description: "Set send policy.",
      key: "send",
      nativeName: "send",
      textAlias: "/send",
    }),
    defineChatCommand({
      acceptsArgs: true,
      category: "session",
      description: "Reset the current session.",
      key: "reset",
      nativeName: "reset",
      textAlias: "/reset",
    }),
    defineChatCommand({
      acceptsArgs: true,
      category: "session",
      description: "Start a new session.",
      key: "new",
      nativeName: "new",
      textAlias: "/new",
    }),
    defineChatCommand({
      args: [
        {
          captureRemaining: true,
          description: "Extra compaction instructions",
          name: "instructions",
          type: "string",
        },
      ],
      category: "session",
      description: "Compact the session context.",
      key: "compact",
      nativeName: "compact",
      textAlias: "/compact",
    }),
    defineChatCommand({
      args: [
        {
          choices: ({ provider, model }) => listThinkingLevels(provider, model),
          description: "off, minimal, low, medium, high, xhigh",
          name: "level",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "options",
      description: "Set thinking level.",
      key: "think",
      nativeName: "think",
      textAlias: "/think",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["on", "off"],
          description: "on or off",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "options",
      description: "Toggle verbose mode.",
      key: "verbose",
      nativeName: "verbose",
      textAlias: "/verbose",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["status", "on", "off"],
          description: "status, on, or off",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "options",
      description: "Toggle fast mode.",
      key: "fast",
      nativeName: "fast",
      textAlias: "/fast",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["on", "off", "stream"],
          description: "on, off, or stream",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "options",
      description: "Toggle reasoning visibility.",
      key: "reasoning",
      nativeName: "reasoning",
      textAlias: "/reasoning",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["on", "off", "ask", "full"],
          description: "on, off, ask, or full",
          name: "mode",
          type: "string",
        },
      ],
      argsMenu: "auto",
      category: "options",
      description: "Toggle elevated mode.",
      key: "elevated",
      nativeName: "elevated",
      textAlias: "/elevated",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["sandbox", "gateway", "node"],
          description: "sandbox, gateway, or node",
          name: "host",
          type: "string",
        },
        {
          choices: ["deny", "allowlist", "full"],
          description: "deny, allowlist, or full",
          name: "security",
          type: "string",
        },
        {
          choices: ["off", "on-miss", "always"],
          description: "off, on-miss, or always",
          name: "ask",
          type: "string",
        },
        {
          description: "Node id or name",
          name: "node",
          type: "string",
        },
      ],
      argsParsing: "none",
      category: "options",
      description: "Set exec defaults for this session.",
      formatArgs: COMMAND_ARG_FORMATTERS.exec,
      key: "exec",
      nativeName: "exec",
      textAlias: "/exec",
    }),
    defineChatCommand({
      args: [
        {
          description: "Model id (provider/model or id)",
          name: "model",
          type: "string",
        },
      ],
      category: "options",
      description: "Show or set the model.",
      key: "model",
      nativeName: "model",
      textAlias: "/model",
    }),
    defineChatCommand({
      acceptsArgs: true,
      argsParsing: "none",
      category: "options",
      description: "List model providers or provider models.",
      key: "models",
      nativeName: "models",
      textAlias: "/models",
    }),
    defineChatCommand({
      args: [
        {
          choices: ["steer", "interrupt", "followup", "collect", "steer-backlog"],
          description: "queue mode",
          name: "mode",
          type: "string",
        },
        {
          description: "debounce duration (e.g. 500ms, 2s)",
          name: "debounce",
          type: "string",
        },
        {
          description: "queue cap",
          name: "cap",
          type: "number",
        },
        {
          choices: ["old", "new", "summarize"],
          description: "drop policy",
          name: "drop",
          type: "string",
        },
      ],
      argsParsing: "none",
      category: "options",
      description: "Adjust queue settings.",
      formatArgs: COMMAND_ARG_FORMATTERS.queue,
      key: "queue",
      nativeName: "queue",
      textAlias: "/queue",
    }),
    defineChatCommand({
      args: [
        {
          captureRemaining: true,
          description: "Shell command",
          name: "command",
          type: "string",
        },
      ],
      category: "tools",
      description: "Run host shell commands (host-only).",
      key: "bash",
      scope: "text",
      textAlias: "/bash",
    }),
  ];

  registerAlias(commands, "whoami", "/id");
  registerAlias(commands, "think", "/thinking", "/t");
  registerAlias(commands, "verbose", "/v");
  registerAlias(commands, "reasoning", "/reason");
  registerAlias(commands, "elevated", "/elev");
  registerAlias(commands, "steer", "/tell");
  assertCommandRegistry(commands);
  return commands;
}
