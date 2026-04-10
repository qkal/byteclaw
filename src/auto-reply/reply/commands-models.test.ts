import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramModelsProviderChannelData } from "../../../test/helpers/channels/command-contract.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleModelsCommand } from "./commands-models.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { id: "claude-opus-4-5", name: "Claude Opus", provider: "anthropic" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet", provider: "anthropic" },
    { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
    { id: "gemini-2.0-flash", name: "Gemini Flash", provider: "google" },
  ]),
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: () => undefined,
}));

const telegramModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: {
      blockStreaming: true,
      chatTypes: ["direct", "group", "channel", "thread"],
      media: true,
      nativeCommands: true,
      polls: true,
      reactions: true,
      threads: true,
    },
    docsPath: "/channels/telegram",
    id: "telegram",
    label: "Telegram",
  }),
  commands: {
    buildModelsProviderChannelData: buildTelegramModelsProviderChannelData,
  },
};

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: telegramModelsTestPlugin,
        pluginId: "telegram",
        source: "test",
      },
    ]),
  );
});

function buildModelsParams(
  commandBody: string,
  cfg: OpenClawConfig,
  surface: string,
  options?: {
    authorized?: boolean;
    agentId?: string;
    sessionKey?: string;
  },
): HandleCommandsParams {
  const params = {
    cfg,
    command: {
      commandBodyNormalized: commandBody,
      isAuthorizedSender: true,
      senderId: "owner",
    },
    ctx: {
      CommandSource: "text",
      Provider: surface,
      Surface: surface,
    },
    model: "claude-opus-4-5",
    provider: "anthropic",
    sessionKey: "agent:main:main",
  } as unknown as HandleCommandsParams;
  if (options?.authorized === false) {
    params.command.isAuthorizedSender = false;
    params.command.senderId = "unauthorized";
  }
  if (options?.agentId) {
    params.agentId = options.agentId;
  }
  if (options?.sessionKey) {
    params.sessionKey = options.sessionKey;
  }
  return params;
}

describe("handleModelsCommand", () => {
  const cfg = {
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    commands: { text: true },
  } as OpenClawConfig;

  it.each(["discord", "whatsapp"])("lists providers on %s text surfaces", async (surface) => {
    const result = await handleModelsCommand(buildModelsParams("/models", cfg, surface), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Providers:");
    expect(result?.reply?.text).toContain("anthropic");
    expect(result?.reply?.text).toContain("Use: /models <provider>");
  });

  it("rejects unauthorized /models commands", async () => {
    const result = await handleModelsCommand(
      buildModelsParams("/models", cfg, "discord", { authorized: false }),
      true,
    );
    expect(result).toEqual({ shouldContinue: false });
  });

  it("lists providers on telegram with buttons", async () => {
    const result = await handleModelsCommand(buildModelsParams("/models", cfg, "telegram"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("Select a provider:");
    const buttons = (result?.reply?.channelData as { telegram?: { buttons?: unknown[][] } })
      ?.telegram?.buttons;
    expect(buttons).toBeDefined();
    expect(buttons?.length).toBeGreaterThan(0);
  });

  it("handles provider pagination all mode and unknown providers", async () => {
    const cases = [
      {
        command: "/models anthropic",
        excludes: [],
        includes: [
          "Models (anthropic",
          "page 1/",
          "anthropic/claude-opus-4-5",
          "Switch: /model <provider/model>",
          "All: /models anthropic all",
        ],
        name: "lists provider models with pagination hints",
      },
      {
        command: "/models anthropic 3 all",
        excludes: ["Page out of range"],
        includes: ["Models (anthropic", "page 1/1", "anthropic/claude-opus-4-5"],
        name: "ignores page argument when all flag is present",
      },
      {
        command: "/models anthropic 4",
        excludes: [],
        includes: ["Page out of range", "valid: 1-"],
        name: "errors on out-of-range pages",
      },
      {
        command: "/models not-a-provider",
        excludes: [],
        includes: ["Unknown provider", "Available providers"],
        name: "handles unknown providers",
      },
    ] as const;

    for (const testCase of cases) {
      const result = await handleModelsCommand(
        buildModelsParams(testCase.command, cfg, "discord"),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      for (const expected of testCase.includes) {
        expect(result?.reply?.text, `${testCase.name}: ${expected}`).toContain(expected);
      }
      for (const blocked of testCase.excludes) {
        expect(result?.reply?.text, `${testCase.name}: !${blocked}`).not.toContain(blocked);
      }
    }
  });

  it("lists configured models outside the curated catalog", async () => {
    const customCfg = {
      agents: {
        defaults: {
          imageModel: "visionpro/studio-v1",
          model: {
            fallbacks: ["anthropic/claude-opus-4-5"],
            primary: "localai/ultra-chat",
          },
        },
      },
      commands: { text: true },
    } as OpenClawConfig;

    const providerList = await handleModelsCommand(
      buildModelsParams("/models", customCfg, "discord"),
      true,
    );
    expect(providerList?.reply?.text).toContain("localai");
    expect(providerList?.reply?.text).toContain("visionpro");

    const result = await handleModelsCommand(
      buildModelsParams("/models localai", customCfg, "discord"),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Models (localai");
    expect(result?.reply?.text).toContain("localai/ultra-chat");
    expect(result?.reply?.text).not.toContain("Unknown provider");
  });

  it("threads the routed agent through /models replies", async () => {
    const scopedCfg = {
      agents: {
        defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
        list: [{ id: "support", model: "localai/ultra-chat" }],
      },
      commands: { text: true },
    } as OpenClawConfig;

    const result = await handleModelsCommand(
      buildModelsParams("/models", scopedCfg, "discord", {
        agentId: "support",
        sessionKey: "agent:support:main",
      }),
      true,
    );

    expect(result?.reply?.text).toContain("localai");
  });
});
