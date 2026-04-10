import type { OpenClawConfig } from "../config/config.js";
import { buildPluginApi } from "./api-builder.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  AnyAgentTool,
  CliBackendPlugin,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MusicGenerationProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

interface CapturedPluginCliRegistration {
  register: OpenClawPluginCliRegistrar;
  commands: string[];
  descriptors: OpenClawPluginCliCommandDescriptor[];
}

export interface CapturedPluginRegistration {
  api: OpenClawPluginApi;
  providers: ProviderPlugin[];
  cliRegistrars: CapturedPluginCliRegistration[];
  cliBackends: CliBackendPlugin[];
  speechProviders: SpeechProviderPlugin[];
  realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[];
  realtimeVoiceProviders: RealtimeVoiceProviderPlugin[];
  mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[];
  imageGenerationProviders: ImageGenerationProviderPlugin[];
  videoGenerationProviders: VideoGenerationProviderPlugin[];
  musicGenerationProviders: MusicGenerationProviderPlugin[];
  webFetchProviders: WebFetchProviderPlugin[];
  webSearchProviders: WebSearchProviderPlugin[];
  memoryEmbeddingProviders: MemoryEmbeddingProviderAdapter[];
  tools: AnyAgentTool[];
}

export function createCapturedPluginRegistration(params?: {
  config?: OpenClawConfig;
  registrationMode?: OpenClawPluginApi["registrationMode"];
}): CapturedPluginRegistration {
  const providers: ProviderPlugin[] = [];
  const cliRegistrars: CapturedPluginCliRegistration[] = [];
  const cliBackends: CliBackendPlugin[] = [];
  const speechProviders: SpeechProviderPlugin[] = [];
  const realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[] = [];
  const realtimeVoiceProviders: RealtimeVoiceProviderPlugin[] = [];
  const mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[] = [];
  const imageGenerationProviders: ImageGenerationProviderPlugin[] = [];
  const videoGenerationProviders: VideoGenerationProviderPlugin[] = [];
  const musicGenerationProviders: MusicGenerationProviderPlugin[] = [];
  const webFetchProviders: WebFetchProviderPlugin[] = [];
  const webSearchProviders: WebSearchProviderPlugin[] = [];
  const memoryEmbeddingProviders: MemoryEmbeddingProviderAdapter[] = [];
  const tools: AnyAgentTool[] = [];
  const noopLogger = {
    debug() {},
    error() {},
    info() {},
    warn() {},
  };

  return {
    api: buildPluginApi({
      config: params?.config ?? ({} as OpenClawConfig),
      handlers: {
        registerCli(registrar, opts) {
          const descriptors = (opts?.descriptors ?? [])
            .map((descriptor) => ({
              name: descriptor.name.trim(),
              description: descriptor.description.trim(),
              hasSubcommands: descriptor.hasSubcommands,
            }))
            .filter((descriptor) => descriptor.name && descriptor.description);
          const commands = [
            ...(opts?.commands ?? []),
            ...descriptors.map((descriptor) => descriptor.name),
          ]
            .map((command) => command.trim())
            .filter(Boolean);
          if (commands.length === 0) {
            return;
          }
          cliRegistrars.push({
            register: registrar,
            commands,
            descriptors,
          });
        },
        registerCliBackend(backend: CliBackendPlugin) {
          cliBackends.push(backend);
        },
        registerImageGenerationProvider(provider: ImageGenerationProviderPlugin) {
          imageGenerationProviders.push(provider);
        },
        registerMediaUnderstandingProvider(provider: MediaUnderstandingProviderPlugin) {
          mediaUnderstandingProviders.push(provider);
        },
        registerMemoryEmbeddingProvider(adapter: MemoryEmbeddingProviderAdapter) {
          memoryEmbeddingProviders.push(adapter);
        },
        registerMusicGenerationProvider(provider: MusicGenerationProviderPlugin) {
          musicGenerationProviders.push(provider);
        },
        registerProvider(provider: ProviderPlugin) {
          providers.push(provider);
        },
        registerRealtimeTranscriptionProvider(provider: RealtimeTranscriptionProviderPlugin) {
          realtimeTranscriptionProviders.push(provider);
        },
        registerRealtimeVoiceProvider(provider: RealtimeVoiceProviderPlugin) {
          realtimeVoiceProviders.push(provider);
        },
        registerSpeechProvider(provider: SpeechProviderPlugin) {
          speechProviders.push(provider);
        },
        registerTool(tool) {
          if (typeof tool !== "function") {
            tools.push(tool);
          }
        },
        registerVideoGenerationProvider(provider: VideoGenerationProviderPlugin) {
          videoGenerationProviders.push(provider);
        },
        registerWebFetchProvider(provider: WebFetchProviderPlugin) {
          webFetchProviders.push(provider);
        },
        registerWebSearchProvider(provider: WebSearchProviderPlugin) {
          webSearchProviders.push(provider);
        },
      },
      id: "captured-plugin-registration",
      logger: noopLogger,
      name: "Captured Plugin Registration",
      registrationMode: params?.registrationMode ?? "full",
      resolvePath: (input) => input,
      runtime: {} as PluginRuntime,
      source: "captured-plugin-registration",
    }),
    cliBackends,
    cliRegistrars,
    imageGenerationProviders,
    mediaUnderstandingProviders,
    memoryEmbeddingProviders,
    musicGenerationProviders,
    providers,
    realtimeTranscriptionProviders,
    realtimeVoiceProviders,
    speechProviders,
    tools,
    videoGenerationProviders,
    webFetchProviders,
    webSearchProviders,
  };
}

export function capturePluginRegistration(params: {
  register(api: OpenClawPluginApi): void;
}): CapturedPluginRegistration {
  const captured = createCapturedPluginRegistration();
  params.register(captured.api);
  return captured;
}
