import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCommandDefinition } from "../../auto-reply/commands-registry.types.js";

const mockSkillCommands = [
  {
    acceptsArgs: true,
    description: "Run code review",
    name: "code_review",
    skillName: "code-review",
  },
];

const mockChatCommands: ChatCommandDefinition[] = [
  {
    acceptsArgs: true,
    args: [
      {
        choices: [{ value: "gpt-5.4", label: "GPT-5.4" }, "sonnet-4.6"],
        description: "Model identifier",
        name: "model",
        type: "string",
      },
    ],
    category: "options",
    description: "Set model",
    key: "model",
    nativeName: "model",
    scope: "both",
    textAliases: ["/model", "/m"],
  },
  {
    category: "session",
    description: "Show help",
    key: "help",
    nativeName: "help",
    scope: "both",
    textAliases: ["/help"],
  },
  {
    category: "session",
    description: "List commands",
    key: "commands",
    scope: "text",
    textAliases: ["/commands"],
  },
  {
    acceptsArgs: true,
    category: "tools",
    description: "Run code review",
    key: "skill:code-review",
    nativeName: "code_review",
    scope: "both",
    textAliases: ["/code_review"],
  },
  {
    acceptsArgs: false,
    args: [
      {
        choices: () => [{ value: "last", label: "Last" }],
        description: "Prompt target",
        name: "target",
        type: "string",
      },
    ],
    category: "tools",
    description: "Show raw prompt",
    key: "debug_prompt",
    nativeName: "debug_prompt",
    scope: "native",
    textAliases: ["/debug"],
  },
];

const mockPluginSpecs = [{ acceptsArgs: false, description: "Text to speech", name: "tts" }];

vi.mock("../../auto-reply/commands-registry.js", () => ({
  listChatCommandsForConfig: vi.fn(() => mockChatCommands),
}));
vi.mock("../../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents: vi.fn(() => mockSkillCommands),
}));
vi.mock("../../plugins/command-registry-state.js", () => ({
  getPluginCommandSpecs: vi.fn((provider?: string) => {
    if (provider === "whatsapp") {
      return [];
    }
    if (provider === "discord") {
      return [{ acceptsArgs: false, description: "Text to speech", name: "discord_tts" }];
    }
    return mockPluginSpecs;
  }),
}));
vi.mock("../../plugins/commands.js", () => ({
  listPluginCommands: vi.fn(() => [
    {
      acceptsArgs: false,
      description: "Text to speech",
      name: "tts",
      pluginId: "plugin-tts",
    },
  ]),
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main", "dev"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));
vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn((provider: string) => {
    if (provider === "discord") {
      return {
        commands: {
          resolveNativeCommandName: ({
            commandKey,
            defaultName,
          }: {
            commandKey: string;
            defaultName: string;
          }) => {
            if (commandKey === "model") {
              return "set_model";
            }
            return defaultName;
          },
        },
      };
    }
    return undefined;
  }),
}));

import { ErrorCodes, errorShape } from "../protocol/index.js";
import { commandsHandlers, buildCommandsListResult } from "./commands.js";

function callHandler(params: Record<string, unknown> = {}) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    result = { error, ok, payload };
  };
  commandsHandlers["commands.list"]({
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params,
    req: {} as never,
    respond,
  });
  return result!;
}

describe("commands.list handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all command sources", () => {
    const { ok, payload } = callHandler();
    expect(ok).toBe(true);
    const { commands } = payload as { commands: { name: string; source: string }[] };
    const sources = new Set(commands.map((c) => c.source));
    expect(sources).toEqual(new Set(["native", "skill", "plugin"]));
  });

  it("maps native commands with category, scope, and args", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Record<string, unknown>[] };
    const model = commands.find((c) => c.name === "model");
    expect(model).toMatchObject({
      acceptsArgs: true,
      category: "options",
      description: "Set model",
      name: "model",
      nativeName: "model",
      scope: "both",
      source: "native",
      textAliases: ["/model", "/m"],
    });
    const args = model!.args as Record<string, unknown>[];
    expect(args).toHaveLength(1);
    expect(args[0].choices).toEqual([
      { label: "GPT-5.4", value: "gpt-5.4" },
      { label: "sonnet-4.6", value: "sonnet-4.6" },
    ]);
  });

  it("exposes per-command scope", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: { name: string; scope: string }[] };
    expect(commands.find((c) => c.name === "model")!.scope).toBe("both");
    expect(commands.find((c) => c.name === "commands")!.scope).toBe("text");
    expect(commands.find((c) => c.name === "debug_prompt")!.scope).toBe("native");
    expect(commands.find((c) => c.name === "tts")!.scope).toBe("both");
  });

  it("skips args when acceptsArgs is false", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Record<string, unknown>[] };
    const debug = commands.find((c) => c.name === "debug_prompt");
    expect(debug!.args).toBeUndefined();
  });

  it("serializes dynamic choices when acceptsArgs is true", () => {
    const debugCmd = mockChatCommands.find((c) => c.key === "debug_prompt")!;
    const saved = debugCmd.acceptsArgs;
    debugCmd.acceptsArgs = true;
    try {
      const { payload } = callHandler();
      const { commands } = payload as { commands: Record<string, unknown>[] };
      const debug = commands.find((c) => c.name === "debug_prompt");
      const args = debug!.args as Record<string, unknown>[];
      expect(args[0].dynamic).toBe(true);
      expect(args[0].choices).toBeUndefined();
    } finally {
      debugCmd.acceptsArgs = saved;
    }
  });

  it("identifies skill commands by source", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Record<string, unknown>[] };
    const skill = commands.find((c) => c.name === "code_review");
    expect(skill).toMatchObject({ category: "tools", source: "skill" });
  });

  it("always includes plugin commands regardless of scope filter", () => {
    for (const scope of ["native", "text", "both"] as const) {
      const { payload } = callHandler({ scope });
      const { commands } = payload as { commands: { name: string; source: string }[] };
      expect(commands.some((c) => c.source === "plugin")).toBe(true);
    }
  });

  it("filters built-in commands by scope=native (excludes text-only)", () => {
    const { payload } = callHandler({ scope: "native" });
    const { commands } = payload as { commands: { name: string; source: string }[] };
    const builtinNames = commands.filter((c) => c.source !== "plugin").map((c) => c.name);
    expect(builtinNames).not.toContain("commands");
    expect(builtinNames).toContain("model");
    expect(builtinNames).toContain("debug_prompt");
  });

  it("filters built-in commands by scope=text (excludes native-only)", () => {
    const { payload } = callHandler({ scope: "text" });
    const { commands } = payload as { commands: { name: string; source: string }[] };
    const builtinNames = commands.filter((c) => c.source !== "plugin").map((c) => c.name);
    expect(builtinNames).toContain("commands");
    expect(builtinNames).not.toContain("debug_prompt");
  });

  it("resolves provider-specific native names", () => {
    const { payload } = callHandler({ provider: "discord" });
    const { commands } = payload as { commands: { name: string }[] };
    expect(commands.find((c) => c.name === "set_model")).toBeDefined();
    expect(commands.find((c) => c.name === "model")).toBeUndefined();
  });

  it("normalizes mixed-case provider", () => {
    const { payload } = callHandler({ provider: "Discord" });
    const { commands } = payload as { commands: { name: string; source: string }[] };
    expect(commands.find((c) => c.name === "set_model")).toBeDefined();
    const plugin = commands.find((c) => c.source === "plugin");
    expect(plugin).toMatchObject({ name: "discord_tts" });
  });

  it("uses default names without provider", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: { name: string }[] };
    expect(commands.find((c) => c.name === "model")).toBeDefined();
    expect(commands.find((c) => c.name === "set_model")).toBeUndefined();
  });

  it("omits plugin commands when provider lacks nativeCommandsAutoEnabled", () => {
    const { payload } = callHandler({ provider: "whatsapp" });
    const { commands } = payload as { commands: { name: string; source: string }[] };
    expect(commands.filter((c) => c.source === "plugin")).toEqual([]);
  });

  it("uses text-surface names when scope=text even with provider-native aliases", () => {
    const { payload } = callHandler({ provider: "discord", scope: "text" });
    const { commands } = payload as {
      commands: {
        name: string;
        nativeName?: string;
        textAliases?: string[];
        source: string;
      }[];
    };
    const model = commands.find((c) => c.source === "native" && c.name === "model");
    expect(model).toMatchObject({
      name: "model",
      nativeName: "set_model",
      textAliases: ["/model", "/m"],
    });
    expect(commands.find((c) => c.name === "set_model")).toBeUndefined();
  });

  it("keeps plugin text commands visible for scope=text even without native provider support", () => {
    const { payload } = callHandler({ provider: "whatsapp", scope: "text" });
    const { commands } = payload as {
      commands: {
        name: string;
        source: string;
        textAliases?: string[];
        nativeName?: string;
      }[];
    };
    expect(commands.find((c) => c.source === "plugin")).toMatchObject({
      name: "tts",
      textAliases: ["/tts"],
    });
    expect(commands.find((c) => c.source === "plugin")?.nativeName).toBeUndefined();
  });

  it("keeps plugin text names while exposing provider-native aliases for scope=text", () => {
    const { payload } = callHandler({ provider: "discord", scope: "text" });
    const { commands } = payload as {
      commands: {
        name: string;
        source: string;
        textAliases?: string[];
        nativeName?: string;
      }[];
    };
    expect(commands.find((c) => c.source === "plugin")).toMatchObject({
      name: "tts",
      nativeName: "discord_tts",
      textAliases: ["/tts"],
    });
  });

  it("returns provider-specific plugin command names", () => {
    const { payload } = callHandler({ provider: "discord" });
    const { commands } = payload as { commands: { name: string; source: string }[] };
    const plugin = commands.find((c) => c.source === "plugin");
    expect(plugin).toMatchObject({ name: "discord_tts" });
  });

  it("excludes args when includeArgs=false", () => {
    const { payload } = callHandler({ includeArgs: false });
    const { commands } = payload as { commands: Record<string, unknown>[] };
    const model = commands.find((c) => c.name === "model");
    expect(model!.args).toBeUndefined();
  });

  it("rejects unknown agentId", () => {
    const { ok, error } = callHandler({ agentId: "nonexistent" });
    expect(ok).toBe(false);
    expect(error).toEqual(errorShape(ErrorCodes.INVALID_REQUEST, 'unknown agent id "nonexistent"'));
  });

  it("rejects invalid params", () => {
    const { ok, error } = callHandler({ scope: "invalid" });
    expect(ok).toBe(false);
    expect((error as { code: number }).code).toBe(ErrorCodes.INVALID_REQUEST);
  });
});

describe("buildCommandsListResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is callable independently from handler", () => {
    const result = buildCommandsListResult({ agentId: "main", cfg: {} as never });
    expect(result.commands.length).toBeGreaterThan(0);
    expect(result.commands.every((c) => typeof c.scope === "string")).toBe(true);
  });
});
