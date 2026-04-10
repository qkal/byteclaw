import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./types.js";

export function createMockPluginRegistry(
  hooks: {
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
  }[],
): PluginRegistry {
  const pluginIds =
    hooks.length > 0
      ? [...new Set(hooks.map((hook) => hook.pluginId ?? "test-plugin"))]
      : ["test-plugin"];
  return {
    channelSetups: [],
    channels: [],
    cliRegistrars: [],
    commands: [],
    diagnostics: [],
    gatewayHandlers: {},
    hooks: hooks as never[],
    httpRoutes: [],
    imageGenerationProviders: [],
    mediaUnderstandingProviders: [],
    musicGenerationProviders: [],
    plugins: pluginIds.map((pluginId) =>
      createPluginRecord({
        hookCount: hooks.filter((hook) => (hook.pluginId ?? "test-plugin") === pluginId).length,
        id: pluginId,
        name: "Test Plugin",
        source: "test",
      }),
    ),
    providers: [],
    services: [],
    speechProviders: [],
    tools: [],
    typedHooks: hooks.map((h) => ({
      handler: h.handler,
      hookName: h.hookName,
      pluginId: h.pluginId ?? "test-plugin",
      priority: 0,
      source: "test",
    })),
    videoGenerationProviders: [],
    webSearchProviders: [],
  } as unknown as PluginRegistry;
}

export const TEST_PLUGIN_AGENT_CTX: PluginHookAgentContext = {
  agentId: "test-agent",
  messageProvider: "test",
  runId: "test-run-id",
  sessionId: "test-session-id",
  sessionKey: "test-session",
  workspaceDir: "/tmp/openclaw-test",
};

export function addTestHook(params: {
  registry: PluginRegistry;
  pluginId: string;
  hookName: PluginHookRegistration["hookName"];
  handler: PluginHookRegistration["handler"];
  priority?: number;
}) {
  params.registry.typedHooks.push({
    handler: params.handler,
    hookName: params.hookName,
    pluginId: params.pluginId,
    priority: params.priority ?? 0,
    source: "test",
  } as PluginHookRegistration);
}

export function addTestHooks(
  registry: PluginRegistry,
  hooks: readonly {
    pluginId: string;
    hookName: PluginHookRegistration["hookName"];
    handler: PluginHookRegistration["handler"];
    priority?: number;
  }[],
) {
  for (const hook of hooks) {
    addTestHook({
      handler: hook.handler,
      hookName: hook.hookName,
      pluginId: hook.pluginId,
      registry,
      ...(hook.priority !== undefined ? { priority: hook.priority } : {}),
    });
  }
}

export function addStaticTestHooks<TResult>(
  registry: PluginRegistry,
  params: {
    hookName: PluginHookRegistration["hookName"];
    hooks: readonly {
      pluginId: string;
      result: TResult;
      priority?: number;
      handler?: () => TResult | Promise<TResult>;
    }[];
  },
) {
  addTestHooks(
    registry,
    params.hooks.map(({ pluginId, result, priority, handler }) => ({
      handler: (handler ?? (() => result)) as PluginHookRegistration["handler"],
      hookName: params.hookName,
      pluginId,
      ...(priority !== undefined ? { priority } : {}),
    })),
  );
}

export function createHookRunnerWithRegistry(
  hooks: {
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
  }[],
  options?: Parameters<typeof createHookRunner>[1],
) {
  const registry = createMockPluginRegistry(hooks);
  return {
    registry,
    runner: createHookRunner(registry, options),
  };
}
