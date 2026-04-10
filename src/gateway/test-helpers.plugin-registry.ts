import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createDefaultGatewayTestChannels } from "./test-helpers.channels.js";
import { createDefaultGatewayTestSpeechProviders } from "./test-helpers.speech.js";

function createStubPluginRegistry(): PluginRegistry {
  return {
    channelSetups: [],
    channels: createDefaultGatewayTestChannels(),
    cliRegistrars: [],
    commands: [],
    conversationBindingResolvedHandlers: [],
    diagnostics: [],
    gatewayHandlers: {},
    hooks: [],
    httpRoutes: [],
    imageGenerationProviders: [],
    mediaUnderstandingProviders: [],
    memoryEmbeddingProviders: [],
    musicGenerationProviders: [],
    plugins: [],
    providers: [],
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    services: [],
    speechProviders: createDefaultGatewayTestSpeechProviders(),
    tools: [],
    typedHooks: [],
    videoGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
  };
}

const GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY = Symbol.for(
  "openclaw.gatewayTestHelpers.pluginRegistryState",
);

const pluginRegistryState = resolveGlobalSingleton(GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY, () => ({
  registry: createStubPluginRegistry(),
}));

setActivePluginRegistry(pluginRegistryState.registry);

export function setTestPluginRegistry(registry: PluginRegistry): void {
  pluginRegistryState.registry = registry;
  setActivePluginRegistry(registry);
}

export function resetTestPluginRegistry(): void {
  pluginRegistryState.registry = createStubPluginRegistry();
  setActivePluginRegistry(pluginRegistryState.registry);
}

export function getTestPluginRegistry(): PluginRegistry {
  return pluginRegistryState.registry;
}
