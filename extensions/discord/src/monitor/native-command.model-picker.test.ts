import { ChannelType } from "discord-api-types/v10";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth";
import type { ChatCommandDefinition, CommandArgsParsing } from "openclaw/plugin-sdk/command-auth";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as pluginRuntimeModule from "openclaw/plugin-sdk/plugin-runtime";
import * as dispatcherModule from "openclaw/plugin-sdk/reply-dispatch-runtime";
import * as globalsModule from "openclaw/plugin-sdk/runtime-env";
import * as commandTextModule from "openclaw/plugin-sdk/text-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.js";
import { createModelsProviderData as createBaseModelsProviderData } from "./model-picker.test-utils.js";
import * as nativeCommandRouteModule from "./native-command-route.js";
import { replyWithDiscordModelPickerProviders } from "./native-command-ui.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  __testing as nativeCommandTesting,
} from "./native-command.js";
import { type ThreadBindingManager, createNoopThreadBindingManager } from "./thread-bindings.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultModelForAgent: () => ({
    model: "claude-sonnet-4.5",
    provider: "anthropic",
  }),
  resolveHumanDelayConfig: () => undefined,
}));

type ModelPickerContext = Parameters<typeof createDiscordModelPickerFallbackButton>[0];
type PickerButton = ReturnType<typeof createDiscordModelPickerFallbackButton>;
type PickerSelect = ReturnType<typeof createDiscordModelPickerFallbackSelect>;
type PickerButtonInteraction = Parameters<PickerButton["run"]>[0];
type PickerButtonData = Parameters<PickerButton["run"]>[1];
type PickerSelectInteraction = Parameters<PickerSelect["run"]>[0];
type PickerSelectData = Parameters<PickerSelect["run"]>[1];

interface MockInteraction {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string; name?: string; parentId?: string };
  guild: { id: string } | null;
  rawData: { id: string; member: { roles: string[] } };
  values?: string[];
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  client: object;
}

function createModelsProviderData(entries: Record<string, string[]>): ModelsProviderData {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}

async function waitForCondition(
  predicate: () => boolean,
  opts?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 50;
  const delayMs = opts?.delayMs ?? 0;
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("condition not met");
}

function createModelPickerContext(): ModelPickerContext {
  const cfg = {
    channels: {
      discord: {
        dm: {
          enabled: true,
          policy: "open",
        },
      },
    },
  } as unknown as OpenClawConfig;

  return {
    accountId: "default",
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

function createInteraction(params?: { userId?: string; values?: string[] }): MockInteraction {
  const userId = params?.userId ?? "owner";
  return {
    acknowledge: vi.fn().mockResolvedValue({ ok: true }),
    channel: {
      id: "dm-1",
      type: ChannelType.DM,
    },
    client: {},
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    guild: null,
    rawData: {
      id: "interaction-1",
      member: { roles: [] },
    },
    reply: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    user: {
      globalName: "Tester",
      id: userId,
      username: "tester",
    },
    values: params?.values,
  };
}

function createDefaultModelPickerData(): ModelsProviderData {
  return createModelsProviderData({
    anthropic: ["claude-sonnet-4-5"],
    openai: ["gpt-4.1", "gpt-4o"],
  });
}

function createModelCommandDefinition(): ChatCommandDefinition {
  return {
    acceptsArgs: true,
    argsParsing: "none" as CommandArgsParsing,
    description: "Switch model",
    key: "model",
    nativeName: "model",
    scope: "native",
    textAliases: ["/model"],
  };
}

function mockModelCommandPipeline(modelCommand: ChatCommandDefinition) {
  vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation((name) =>
    name === "model" ? modelCommand : undefined,
  );
  vi.spyOn(commandRegistryModule, "listChatCommands").mockReturnValue([modelCommand]);
  vi.spyOn(commandRegistryModule, "resolveCommandArgMenu").mockReturnValue(null);
}

function createModelsViewSelectData(): PickerSelectData {
  return {
    act: "model",
    cmd: "model",
    p: "openai",
    pg: "1",
    u: "owner",
    view: "models",
  };
}

function createModelsViewSubmitData(): PickerButtonData {
  return {
    act: "submit",
    cmd: "model",
    mi: "2",
    p: "openai",
    pg: "1",
    u: "owner",
    view: "models",
  };
}

async function runSubmitButton(params: {
  context: ModelPickerContext;
  data: PickerButtonData;
  userId?: string;
}) {
  const button = createDiscordModelPickerFallbackButton(params.context);
  const submitInteraction = createInteraction({ userId: params.userId ?? "owner" });
  await button.run(submitInteraction as unknown as PickerButtonInteraction, params.data);
  return submitInteraction;
}

async function runModelSelect(params: {
  context: ModelPickerContext;
  data?: PickerSelectData;
  userId?: string;
  values?: string[];
}) {
  const select = createDiscordModelPickerFallbackSelect(params.context);
  const selectInteraction = createInteraction({
    userId: params.userId ?? "owner",
    values: params.values ?? ["gpt-4o"],
  });
  await select.run(
    selectInteraction as unknown as PickerSelectInteraction,
    params.data ?? createModelsViewSelectData(),
  );
  return selectInteraction;
}

function expectDispatchedModelSelection(params: {
  dispatchSpy: { mock: { calls: [unknown][] } };
  model: string;
  requireTargetSessionKey?: boolean;
}) {
  const dispatchCall = params.dispatchSpy.mock.calls[0]?.[0] as {
    ctx?: {
      CommandBody?: string;
      CommandArgs?: { values?: { model?: string } };
      CommandTargetSessionKey?: string;
    };
  };
  expect(dispatchCall.ctx?.CommandBody).toBe(`/model ${params.model}`);
  expect(dispatchCall.ctx?.CommandArgs?.values?.model).toBe(params.model);
  if (params.requireTargetSessionKey) {
    if (!dispatchCall.ctx?.CommandTargetSessionKey) {
      throw new Error("model selection dispatch did not include a target session key");
    }
  }
}

function createBoundThreadBindingManager(params: {
  accountId: string;
  threadId: string;
  targetSessionKey: string;
  agentId: string;
}): ThreadBindingManager {
  const baseManager = createNoopThreadBindingManager(params.accountId);
  const now = Date.now();
  return {
    ...baseManager,
    getByThreadId: (threadId: string) =>
      threadId === params.threadId
        ? {
            accountId: params.accountId,
            agentId: params.agentId,
            boundAt: now,
            boundBy: "system",
            channelId: "parent-1",
            idleTimeoutMs: 24 * 60 * 60 * 1000,
            lastActivityAt: now,
            maxAgeMs: 0,
            targetKind: "subagent",
            targetSessionKey: params.targetSessionKey,
            threadId: params.threadId,
          }
        : baseManager.getByThreadId(threadId),
    getIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
    getMaxAgeMs: () => 0,
  };
}

function createDispatchSpy() {
  const dispatchSpy = vi
    .fn<typeof dispatcherModule.dispatchReplyWithDispatcher>()
    .mockResolvedValue({} as never);
  nativeCommandTesting.setDispatchReplyWithDispatcher(dispatchSpy);
  return dispatchSpy;
}

describe("Discord model picker interactions", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    nativeCommandTesting.setMatchPluginCommand(pluginRuntimeModule.matchPluginCommand);
    nativeCommandTesting.setExecutePluginCommand(pluginRuntimeModule.executePluginCommand);
    nativeCommandTesting.setDispatchReplyWithDispatcher(
      dispatcherModule.dispatchReplyWithDispatcher,
    );
    nativeCommandTesting.setResolveDiscordNativeInteractionRouteState(
      nativeCommandRouteModule.resolveDiscordNativeInteractionRouteState,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers distinct fallback ids for button and select handlers", () => {
    const context = createModelPickerContext();
    const button = createDiscordModelPickerFallbackButton(context);
    const select = createDiscordModelPickerFallbackSelect(context);

    expect(button.customId).not.toBe(select.customId);
    expect(button.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
    expect(select.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
  });

  it("ignores interactions from users other than the picker owner", async () => {
    const context = createModelPickerContext();
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "intruder" });

    const data: PickerButtonData = {
      act: "back",
      cmd: "model",
      pg: "1",
      u: "owner",
      view: "providers",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("requires submit click before routing selected model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();

    const selectInteraction = await runModelSelect({ context });

    expect(selectInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();

    const submitInteraction = await runSubmitButton({
      context,
      data: createModelsViewSubmitData(),
    });

    expect(submitInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
      requireTargetSessionKey: true,
    });
  });

  it("shows timeout status and skips recents write when apply is still processing", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const recordRecentSpy = vi
      .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
      .mockResolvedValue();
    const dispatchSpy = createDispatchSpy();
    const withTimeoutSpy = vi
      .spyOn(commandTextModule, "withTimeout")
      .mockRejectedValue(new Error("timeout"));

    await runModelSelect({ context });

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    expect(withTimeoutSpy).toHaveBeenCalledTimes(1);
    await waitForCondition(() => dispatchSpy.mock.calls.length === 1);
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    const followUpPayload = submitInteraction.followUp.mock.calls[0]?.[0] as {
      components?: { components?: { content?: string }[] }[];
    };
    const followUpText = JSON.stringify(followUpPayload);
    expect(followUpText).toContain("still processing");
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });

  it("clicking Recents button renders recents view", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      anthropic: ["claude-sonnet-4-5"],
      openai: ["gpt-4.1", "gpt-4o"],
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);

    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "owner" });

    const data: PickerButtonData = {
      act: "recents",
      cmd: "model",
      p: "openai",
      pg: "1",
      u: "owner",
      view: "recents",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.update).toHaveBeenCalledTimes(1);
    const updatePayload = interaction.update.mock.calls[0]?.[0];
    if (!updatePayload) {
      throw new Error("recents button did not emit an update payload");
    }
    const updateText = JSON.stringify(updatePayload);
    expect(updateText).toContain("gpt-4o");
    expect(updateText).toContain("claude-sonnet-4-5");
  });

  it("clicking recents model button applies model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();

    // Rs=2 -> first deduped recent (default is anthropic/claude-sonnet-4-5, so openai/gpt-4o remains)
    const submitInteraction = await runSubmitButton({
      context,
      data: {
        act: "submit",
        cmd: "model",
        pg: "1",
        rs: "2",
        u: "owner",
        view: "recents",
      },
    });

    expect(submitInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o" });
  });

  it("verifies model state against the bound thread session", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      agentId: "worker",
      targetSessionKey: "agent:worker:subagent:bound",
      threadId: "thread-bound",
    });
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    createDispatchSpy();
    const verboseSpy = vi.spyOn(globalsModule, "logVerbose").mockImplementation(() => {});

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });
    selectInteraction.channel = {
      id: "thread-bound",
      type: ChannelType.PublicThread,
    };
    const selectData = createModelsViewSelectData();
    await select.run(selectInteraction as unknown as PickerSelectInteraction, selectData);

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      id: "thread-bound",
      type: ChannelType.PublicThread,
    };
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    const mismatchLog = verboseSpy.mock.calls.find((call) =>
      String(call[0] ?? "").includes("model picker override mismatch"),
    )?.[0];
    expect(mismatchLog).toContain("session key agent:worker:subagent:bound");
  });

  it("loads model picker data from the effective bound route", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      agentId: "worker",
      targetSessionKey: "agent:worker:subagent:bound",
      threadId: "thread-bound",
    });
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockResolvedValue(createDefaultModelPickerData());
    const interaction = createInteraction({ userId: "owner" });
    interaction.guild = { id: "guild-1" };
    interaction.channel = {
      id: "thread-bound",
      name: "bound-thread",
      parentId: "parent-1",
      type: ChannelType.PublicThread,
    };

    await replyWithDiscordModelPickerProviders({
      accountId: context.accountId,
      cfg: context.cfg,
      command: "model",
      interaction: interaction as never,
      preferFollowUp: false,
      safeInteractionCall: async (_label, fn) => await fn(),
      threadBindings: context.threadBindings,
      userId: "owner",
    });

    expect(loadSpy).toHaveBeenCalledWith(context.cfg, "worker");
  });
});
