import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";

const resolveAgentConfigMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());
const requireActivePluginChannelRegistryMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("./index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistryVersion: getActivePluginChannelRegistryVersionMock,
  requireActivePluginChannelRegistry: requireActivePluginChannelRegistryMock,
}));

async function importConfiguredBindings() {
  const builtins = await import("./configured-binding-builtins.js");
  builtins.ensureConfiguredBindingBuiltinsRegistered();
  return await import("./configured-binding-registry.js");
}

function createConfig(options?: { bindingAgentId?: string; accountId?: string }) {
  return {
    agents: {
      list: [{ id: "main" }, { id: "codex" }],
    },
    bindings: [
      {
        acp: {
          backend: "acpx",
        },
        agentId: options?.bindingAgentId ?? "codex",
        match: {
          accountId: options?.accountId ?? "default",
          channel: "discord",
          peer: {
            id: "1479098716916023408",
            kind: "channel",
          },
        },
        type: "acp",
      },
    ],
  };
}

function createDiscordAcpPlugin(overrides?: {
  compileConfiguredBinding?: ReturnType<typeof vi.fn>;
  matchInboundConversation?: ReturnType<typeof vi.fn>;
}) {
  const compileConfiguredBinding =
    overrides?.compileConfiguredBinding ??
    vi.fn(({ conversationId }: { conversationId: string }) => ({
      conversationId,
    }));
  const matchInboundConversation =
    overrides?.matchInboundConversation ??
    vi.fn(
      ({
        compiledBinding,
        conversationId,
        parentConversationId,
      }: {
        compiledBinding: { conversationId: string };
        conversationId: string;
        parentConversationId?: string;
      }) => {
        if (compiledBinding.conversationId === conversationId) {
          return { conversationId, matchPriority: 2 };
        }
        if (parentConversationId && compiledBinding.conversationId === parentConversationId) {
          return { conversationId: parentConversationId, matchPriority: 1 };
        }
        return null;
      },
    );
  return {
    bindings: {
      compileConfiguredBinding,
      matchInboundConversation,
    },
    id: "discord",
  };
}

describe("configured binding registry", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveAgentConfigMock.mockReset().mockReturnValue(undefined);
    resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
    getChannelPluginMock.mockReset();
    getActivePluginChannelRegistryVersionMock.mockReset().mockReturnValue(1);
    requireActivePluginChannelRegistryMock.mockReset().mockReturnValue({});
  });

  it("resolves configured ACP bindings from an already loaded channel plugin", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    const bindingRegistry = await importConfiguredBindings();

    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      accountId: "default",
      cfg: createConfig() as never,
      channel: "discord",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.record.metadata?.backend).toBe("acpx");
    expect(plugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
  });

  it("resolves configured ACP bindings from canonical conversation refs", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    const bindingRegistry = await importConfiguredBindings();

    const resolved = bindingRegistry.resolveConfiguredBinding({
      cfg: createConfig() as never,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "1479098716916023408",
      },
    });

    expect(resolved?.conversation).toEqual({
      accountId: "default",
      channel: "discord",
      conversationId: "1479098716916023408",
    });
    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.statefulTarget).toEqual({
      agentId: "codex",
      driverId: "acp",
      kind: "stateful",
      label: undefined,
      sessionKey: resolved?.record.targetSessionKey,
    });
  });

  it("primes compiled ACP bindings from the already loaded channel registry once", async () => {
    const plugin = createDiscordAcpPlugin();
    const cfg = createConfig({ bindingAgentId: "codex" });
    getChannelPluginMock.mockReturnValue(plugin);
    const bindingRegistry = await importConfiguredBindings();

    const primed = bindingRegistry.primeConfiguredBindingRegistry({
      cfg: cfg as never,
    });
    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      accountId: "default",
      cfg: cfg as never,
      channel: "discord",
      conversationId: "1479098716916023408",
    });

    expect(primed).toEqual({ bindingCount: 1, channelCount: 1 });
    expect(resolved?.statefulTarget.agentId).toBe("codex");
    expect(plugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);

    const second = bindingRegistry.resolveConfiguredBindingRecord({
      accountId: "default",
      cfg: cfg as never,
      channel: "discord",
      conversationId: "1479098716916023408",
    });

    expect(second?.statefulTarget.agentId).toBe("codex");
  });

  it("resolves wildcard binding session keys from the compiled registry", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    const bindingRegistry = await importConfiguredBindings();

    const resolved = bindingRegistry.resolveConfiguredBindingRecordBySessionKey({
      cfg: createConfig({ accountId: "*" }) as never,
      sessionKey: buildConfiguredAcpSessionKey({
        accountId: "work",
        agentId: "codex",
        backend: "acpx",
        channel: "discord",
        conversationId: "1479098716916023408",
        mode: "persistent",
      }),
    });

    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.record.conversation.accountId).toBe("work");
    expect(resolved?.record.metadata?.backend).toBe("acpx");
  });

  it("does not perform late plugin discovery when a channel plugin is unavailable", async () => {
    const bindingRegistry = await importConfiguredBindings();

    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      accountId: "default",
      cfg: createConfig() as never,
      channel: "discord",
      conversationId: "1479098716916023408",
    });

    expect(resolved).toBeNull();
  });

  it("rebuilds the compiled registry when the active plugin registry version changes", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    getActivePluginChannelRegistryVersionMock.mockReturnValue(10);
    const cfg = createConfig();
    const bindingRegistry = await importConfiguredBindings();

    bindingRegistry.resolveConfiguredBindingRecord({
      accountId: "default",
      cfg: cfg as never,
      channel: "discord",
      conversationId: "1479098716916023408",
    });
    bindingRegistry.resolveConfiguredBindingRecord({
      accountId: "default",
      cfg: cfg as never,
      channel: "discord",
      conversationId: "1479098716916023408",
    });

    getActivePluginChannelRegistryVersionMock.mockReturnValue(11);
    bindingRegistry.resolveConfiguredBindingRecord({
      accountId: "default",
      cfg: cfg as never,
      channel: "discord",
      conversationId: "1479098716916023408",
    });

    expect(plugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(2);
  });
});
