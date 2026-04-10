import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCommandFlagEnabled } from "../../config/commands.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { handleBashChatCommand } from "./bash-command.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({ parsed: {}, valid: true })),
);
const validateConfigObjectWithPluginsMock = vi.hoisted(() =>
  vi.fn(() => ({
    config: {},
    issues: [],
    ok: true,
  })),
);
const writeConfigFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const getConfigOverridesMock = vi.hoisted(() => vi.fn(() => ({})));
const getConfigValueAtPathMock = vi.hoisted(() => vi.fn());
const parseConfigPathMock = vi.hoisted(() => vi.fn());
const setConfigValueAtPathMock = vi.hoisted(() => vi.fn());
const resolveConfigWriteDeniedTextMock = vi.hoisted(() =>
  vi.fn<(...args: never[]) => string | null>(() => null),
);
const isInternalMessageChannelMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "agent:main"),
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getFinishedSession: vi.fn(() => undefined),
  getSession: vi.fn(() => undefined),
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: vi.fn(),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    clampInt: vi.fn((value: number) => value),
  };
});

vi.mock("./mentions.js", () => ({
  stripMentions: vi.fn((value: string) => value),
  stripStructuralPrefixes: vi.fn((value: string) => value),
}));

vi.mock("../../channels/plugins/config-writes.js", () => ({
  resolveConfigWriteTargetFromPath: vi.fn(() => "config"),
}));

vi.mock("../../channels/registry.js", () => ({
  normalizeChannelId: vi.fn((value?: string) => value),
}));

vi.mock("../../config/config-paths.js", () => ({
  getConfigValueAtPath: getConfigValueAtPathMock,
  parseConfigPath: parseConfigPathMock,
  setConfigValueAtPath: setConfigValueAtPathMock,
  unsetConfigValueAtPath: vi.fn(() => true),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../../config/runtime-overrides.js", () => ({
  getConfigOverrides: getConfigOverridesMock,
  resetConfigOverrides: vi.fn(),
  setConfigOverride: vi.fn(() => ({ ok: true })),
  unsetConfigOverride: vi.fn(() => ({ ok: true, removed: true })),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isInternalMessageChannel: isInternalMessageChannelMock,
}));

vi.mock("./channel-context.js", () => ({
  resolveChannelAccountId: vi.fn(() => undefined),
}));

vi.mock("./config-commands.js", () => ({
  parseConfigCommand: vi.fn((raw: string) => {
    if (!raw.startsWith("/config")) {
      return null;
    }
    const parts = raw.trim().split(/\s+/);
    const action = parts[1];
    if (action === "show" || action === "get") {
      return { action: "show", path: parts.slice(2).join(" ") || undefined };
    }
    if (action === "set") {
      const assignment = raw.slice(raw.indexOf(" set ") + 5).trim();
      const equalsIndex = assignment.indexOf("=");
      return {
        action: "set",
        path: assignment.slice(0, equalsIndex),
        value: JSON.parse(assignment.slice(equalsIndex + 1)),
      };
    }
    if (action === "unset") {
      return { action: "unset", path: parts.slice(2).join(" ") };
    }
    return { action: "error", message: "Invalid /config syntax." };
  }),
}));

vi.mock("./config-write-authorization.js", () => ({
  resolveConfigWriteDeniedText: resolveConfigWriteDeniedTextMock,
}));

vi.mock("./debug-commands.js", () => ({
  parseDebugCommand: vi.fn((raw: string) => {
    if (!raw.startsWith("/debug")) {
      return null;
    }
    return { action: "show" };
  }),
}));

function buildParams(commandBody: string, cfg: OpenClawConfig): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandAuthorized: true,
    CommandBody: commandBody,
    CommandSource: "text",
    Provider: "whatsapp",
    SessionKey: "agent:main:main",
    Surface: "whatsapp",
  } as MsgContext;

  return {
    cfg,
    command: {
      channel: "whatsapp",
      channelId: "whatsapp",
      commandBodyNormalized: commandBody.trim(),
      from: "user-1",
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: commandBody.trim(),
      senderId: "user-1",
      senderIsOwner: false,
      surface: "whatsapp",
      to: "bot-1",
    },
    contextTokens: 0,
    ctx,
    defaultGroupActivation: () => "mention",
    directives: parseInlineDirectives(""),
    elevated: { allowed: true, enabled: true, failures: [] },
    isGroup: false,
    model: "test-model",
    provider: "whatsapp",
    resolveDefaultThinkingLevel: async () => undefined,
    resolvedReasoningLevel: "off",
    resolvedVerboseLevel: "off",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
  };
}

describe("command gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({ parsed: {}, valid: true });
    validateConfigObjectWithPluginsMock.mockReturnValue({
      config: {},
      issues: [],
      ok: true,
    });
    getConfigOverridesMock.mockReturnValue({});
    getConfigValueAtPathMock.mockImplementation((target: unknown, path: string[]) => {
      let current = target as Record<string, unknown> | undefined;
      for (const segment of path) {
        if (!current || typeof current !== "object") {
          return undefined;
        }
        current = current[segment] as Record<string, unknown> | undefined;
      }
      return current;
    });
    parseConfigPathMock.mockImplementation((raw: string) => ({
      ok: true,
      path: raw.split("."),
    }));
    setConfigValueAtPathMock.mockImplementation(
      (target: Record<string, unknown>, path: string[], value: unknown) => {
        let cursor: Record<string, unknown> = target;
        for (const segment of path.slice(0, -1)) {
          const next = cursor[segment];
          if (!next || typeof next !== "object") {
            cursor[segment] = {};
          }
          cursor = cursor[segment] as Record<string, unknown>;
        }
        const leaf = path[path.length - 1];
        if (leaf) {
          cursor[leaf] = value;
        }
      },
    );
  });

  it("blocks disabled bash", async () => {
    const result = await handleBashChatCommand({
      cfg: { commands: { bash: false } } as OpenClawConfig,
      ctx: {
        Body: "/bash echo hi",
        CommandBody: "/bash echo hi",
        SessionKey: "agent:main:main",
      } as MsgContext,
      elevated: { allowed: true, enabled: true, failures: [] },
      isGroup: false,
      sessionKey: "agent:main:main",
    });
    expect(result.text).toContain("bash is disabled");
  });

  it("blocks bash when elevated access is unavailable", async () => {
    const result = await handleBashChatCommand({
      cfg: { commands: { bash: true } } as OpenClawConfig,
      ctx: {
        Body: "/bash echo hi",
        CommandBody: "/bash echo hi",
        SessionKey: "agent:main:main",
      } as MsgContext,
      elevated: {
        allowed: false,
        enabled: true,
        failures: [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
      },
      isGroup: false,
      sessionKey: "agent:main:main",
    });
    expect(result.text).toContain("elevated is not available");
  });

  it("blocks disabled config", async () => {
    const params = buildParams("/config show", {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { config: false, debug: false, text: true },
    } as OpenClawConfig);
    params.command.senderIsOwner = true;
    const result = await handleConfigCommand(params, true);
    expect(result?.reply?.text).toContain("/config is disabled");
  });

  it("blocks disabled debug", async () => {
    const params = buildParams("/debug show", {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { config: false, debug: false, text: true },
    } as OpenClawConfig);
    params.command.senderIsOwner = true;
    const result = await handleDebugCommand(params, true);
    expect(result?.reply?.text).toContain("/debug is disabled");
  });

  it("blocks authorized non-owners from /config show and /debug show", async () => {
    const configParams = buildParams("/config show", {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { config: true, text: true },
    } as OpenClawConfig);
    const configResult = await handleConfigCommand(configParams, true);
    expect(configResult).toEqual({ shouldContinue: false });

    const debugParams = buildParams("/debug show", {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { debug: true, text: true },
    } as OpenClawConfig);
    const debugResult = await handleDebugCommand(debugParams, true);
    expect(debugResult).toEqual({ shouldContinue: false });
  });

  it("keeps /config show and /debug show available for owners", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      parsed: { messages: { ackReaction: ":)" } },
      valid: true,
    });
    const configParams = buildParams("/config show messages.ackReaction", {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { config: true, text: true },
    } as OpenClawConfig);
    configParams.command.senderIsOwner = true;
    const configResult = await handleConfigCommand(configParams, true);
    expect(configResult?.reply?.text).toContain("⚙️ Config");
    expect(configResult?.reply?.text).toContain('":)"');

    const debugParams = buildParams("/debug show", {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { debug: true, text: true },
    } as OpenClawConfig);
    debugParams.command.senderIsOwner = true;
    const debugResult = await handleDebugCommand(debugParams, true);
    expect(debugResult?.reply?.text).toContain("Debug overrides");
  });

  it("returns explicit unauthorized replies for native privileged commands", async () => {
    const configParams = buildParams("/config show", {
      channels: { telegram: { allowFrom: ["*"] } },
      commands: { config: true, text: true },
    } as OpenClawConfig);
    configParams.ctx.CommandSource = "native";
    configParams.command.channel = "telegram";
    configParams.command.channelId = "telegram";
    configParams.command.surface = "telegram";
    const configResult = await handleConfigCommand(configParams, true);
    expect(configResult).toEqual({
      reply: { text: "You are not authorized to use this command." },
      shouldContinue: false,
    });

    const debugParams = buildParams("/debug show", {
      channels: { telegram: { allowFrom: ["*"] } },
      commands: { debug: true, text: true },
    } as OpenClawConfig);
    debugParams.ctx.CommandSource = "native";
    debugParams.command.channel = "telegram";
    debugParams.command.channelId = "telegram";
    debugParams.command.surface = "telegram";
    const debugResult = await handleDebugCommand(debugParams, true);
    expect(debugResult).toEqual({
      reply: { text: "You are not authorized to use this command." },
      shouldContinue: false,
    });
  });

  it("ignores inherited command flags", () => {
    const inheritedCommands = Object.create({
      bash: true,
      config: true,
      debug: true,
    }) as Record<string, unknown>;
    const cfg = { commands: inheritedCommands as never } as OpenClawConfig;
    expect(isCommandFlagEnabled(cfg, "bash")).toBe(false);
    expect(isCommandFlagEnabled(cfg, "config")).toBe(false);
    expect(isCommandFlagEnabled(cfg, "debug")).toBe(false);
  });

  it("blocks disallowed /config set writes", async () => {
    resolveConfigWriteDeniedTextMock
      .mockReturnValueOnce("Config writes are disabled")
      .mockReturnValueOnce("channels.telegram.accounts.work.configWrites=true")
      .mockReturnValueOnce("cannot replace channels, channel roots, or accounts collections");

    const cases = [
      {
        expectedText: "Config writes are disabled",
        name: "channel config writes disabled",
        params: (() => {
          const params = buildParams('/config set messages.ackReaction=":)"', {
            channels: { whatsapp: { allowFrom: ["*"], configWrites: false } },
            commands: { config: true, text: true },
          } as OpenClawConfig);
          params.command.senderIsOwner = true;
          return params;
        })(),
      },
      {
        expectedText: "channels.telegram.accounts.work.configWrites=true",
        name: "target account disables writes",
        params: (() => {
          const params = buildParams("/config set channels.telegram.accounts.work.enabled=false", {
            channels: {
              telegram: {
                accounts: {
                  work: { configWrites: false, enabled: true },
                },
                configWrites: true,
              },
            },
            commands: { config: true, text: true },
          } as OpenClawConfig);
          params.ctx.Provider = "telegram";
          params.ctx.Surface = "telegram";
          params.command.channel = "telegram";
          params.command.channelId = "telegram";
          params.command.surface = "telegram";
          params.command.senderIsOwner = true;
          return params;
        })(),
      },
      {
        expectedText: "cannot replace channels, channel roots, or accounts collections",
        name: "ambiguous channel-root write",
        params: (() => {
          const params = buildParams('/config set channels.telegram={"enabled":false}', {
            channels: { telegram: { configWrites: true } },
            commands: { config: true, text: true },
          } as OpenClawConfig);
          params.ctx.Provider = "telegram";
          params.ctx.Surface = "telegram";
          params.command.channel = "telegram";
          params.command.channelId = "telegram";
          params.command.surface = "telegram";
          params.command.senderIsOwner = true;
          return params;
        })(),
      },
    ] as const;

    for (const testCase of cases) {
      const previousWriteCount = writeConfigFileMock.mock.calls.length;
      const result = await handleConfigCommand(testCase.params, true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain(testCase.expectedText);
      expect(writeConfigFileMock.mock.calls.length).toBe(previousWriteCount);
    }
  });

  it("honors the configured default account when gating omitted-account /config writes", async () => {
    resolveConfigWriteDeniedTextMock.mockReturnValueOnce(
      "channels.telegram.accounts.work.configWrites=true",
    );
    const params = buildParams('/config set messages.ackReaction=":)"', {
      channels: {
        telegram: {
          accounts: {
            work: { configWrites: false, enabled: true },
          },
          configWrites: true,
          defaultAccount: "work",
        },
      },
      commands: { config: true, text: true },
    } as OpenClawConfig);
    params.ctx.Provider = "telegram";
    params.ctx.Surface = "telegram";
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.surface = "telegram";
    params.command.senderIsOwner = true;

    const previousWriteCount = writeConfigFileMock.mock.calls.length;
    const result = await handleConfigCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(writeConfigFileMock.mock.calls.length).toBe(previousWriteCount);
  });

  it("enforces gateway client permissions for /config commands", async () => {
    const baseCfg = { commands: { config: true, text: true } } as OpenClawConfig;

    const blockedParams = buildParams('/config set messages.ackReaction=":)"', baseCfg);
    blockedParams.ctx.Provider = "webchat";
    blockedParams.ctx.Surface = "webchat";
    blockedParams.ctx.GatewayClientScopes = ["operator.write"];
    blockedParams.command.channel = "webchat";
    blockedParams.command.channelId = "webchat";
    blockedParams.command.surface = "webchat";
    blockedParams.command.senderIsOwner = true;
    isInternalMessageChannelMock.mockReturnValueOnce(true);
    const blockedResult = await handleConfigCommand(blockedParams, true);
    expect(blockedResult?.shouldContinue).toBe(false);
    expect(blockedResult?.reply?.text).toContain("requires operator.admin");

    readConfigFileSnapshotMock.mockResolvedValueOnce({
      parsed: { messages: { ackReaction: ":)" } },
      valid: true,
    });
    const showParams = buildParams("/config show messages.ackReaction", baseCfg);
    showParams.ctx.Provider = "webchat";
    showParams.ctx.Surface = "webchat";
    showParams.ctx.GatewayClientScopes = ["operator.write"];
    showParams.command.channel = "webchat";
    showParams.command.channelId = "webchat";
    showParams.command.surface = "webchat";
    isInternalMessageChannelMock.mockReturnValueOnce(true);
    const showResult = await handleConfigCommand(showParams, true);
    expect(showResult?.shouldContinue).toBe(false);
    expect(showResult?.reply?.text).toContain("Config messages.ackReaction");

    readConfigFileSnapshotMock.mockResolvedValueOnce({
      parsed: { messages: { ackReaction: ":)" } },
      valid: true,
    });
    const setParams = buildParams('/config set messages.ackReaction=":D"', baseCfg);
    setParams.ctx.Provider = "webchat";
    setParams.ctx.Surface = "webchat";
    setParams.ctx.GatewayClientScopes = ["operator.write", "operator.admin"];
    setParams.command.channel = "webchat";
    setParams.command.channelId = "webchat";
    setParams.command.surface = "webchat";
    setParams.command.senderIsOwner = true;
    isInternalMessageChannelMock.mockReturnValueOnce(true);
    const setResult = await handleConfigCommand(setParams, true);
    expect(setResult?.shouldContinue).toBe(false);
    expect(setResult?.reply?.text).toContain("Config updated");
    expect(writeConfigFileMock).toHaveBeenCalled();
  });
});
