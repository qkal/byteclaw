import type { OpenClawConfig } from "../config/config.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, PluginLogger } from "./types.js";

export interface BuildPluginApiParams {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: OpenClawPluginApi["registrationMode"];
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  handlers?: Partial<
    Pick<
      OpenClawPluginApi,
      | "registerTool"
      | "registerHook"
      | "registerHttpRoute"
      | "registerChannel"
      | "registerGatewayMethod"
      | "registerCli"
      | "registerReload"
      | "registerNodeHostCommand"
      | "registerSecurityAuditCollector"
      | "registerService"
      | "registerCliBackend"
      | "registerConfigMigration"
      | "registerAutoEnableProbe"
      | "registerProvider"
      | "registerSpeechProvider"
      | "registerRealtimeTranscriptionProvider"
      | "registerRealtimeVoiceProvider"
      | "registerMediaUnderstandingProvider"
      | "registerImageGenerationProvider"
      | "registerVideoGenerationProvider"
      | "registerMusicGenerationProvider"
      | "registerWebFetchProvider"
      | "registerWebSearchProvider"
      | "registerInteractiveHandler"
      | "onConversationBindingResolved"
      | "registerCommand"
      | "registerContextEngine"
      | "registerCompactionProvider"
      | "registerMemoryCapability"
      | "registerMemoryPromptSection"
      | "registerMemoryPromptSupplement"
      | "registerMemoryCorpusSupplement"
      | "registerMemoryFlushPlan"
      | "registerMemoryRuntime"
      | "registerMemoryEmbeddingProvider"
      | "on"
    >
  >;
}

const noopRegisterTool: OpenClawPluginApi["registerTool"] = () => {};
const noopRegisterHook: OpenClawPluginApi["registerHook"] = () => {};
const noopRegisterHttpRoute: OpenClawPluginApi["registerHttpRoute"] = () => {};
const noopRegisterChannel: OpenClawPluginApi["registerChannel"] = () => {};
const noopRegisterGatewayMethod: OpenClawPluginApi["registerGatewayMethod"] = () => {};
const noopRegisterCli: OpenClawPluginApi["registerCli"] = () => {};
const noopRegisterReload: OpenClawPluginApi["registerReload"] = () => {};
const noopRegisterNodeHostCommand: OpenClawPluginApi["registerNodeHostCommand"] = () => {};
const noopRegisterSecurityAuditCollector: OpenClawPluginApi["registerSecurityAuditCollector"] =
  () => {};
const noopRegisterService: OpenClawPluginApi["registerService"] = () => {};
const noopRegisterCliBackend: OpenClawPluginApi["registerCliBackend"] = () => {};
const noopRegisterConfigMigration: OpenClawPluginApi["registerConfigMigration"] = () => {};
const noopRegisterAutoEnableProbe: OpenClawPluginApi["registerAutoEnableProbe"] = () => {};
const noopRegisterProvider: OpenClawPluginApi["registerProvider"] = () => {};
const noopRegisterSpeechProvider: OpenClawPluginApi["registerSpeechProvider"] = () => {};
const noopRegisterRealtimeTranscriptionProvider: OpenClawPluginApi["registerRealtimeTranscriptionProvider"] =
  () => {};
const noopRegisterRealtimeVoiceProvider: OpenClawPluginApi["registerRealtimeVoiceProvider"] =
  () => {};
const noopRegisterMediaUnderstandingProvider: OpenClawPluginApi["registerMediaUnderstandingProvider"] =
  () => {};
const noopRegisterImageGenerationProvider: OpenClawPluginApi["registerImageGenerationProvider"] =
  () => {};
const noopRegisterVideoGenerationProvider: OpenClawPluginApi["registerVideoGenerationProvider"] =
  () => {};
const noopRegisterMusicGenerationProvider: OpenClawPluginApi["registerMusicGenerationProvider"] =
  () => {};
const noopRegisterWebFetchProvider: OpenClawPluginApi["registerWebFetchProvider"] = () => {};
const noopRegisterWebSearchProvider: OpenClawPluginApi["registerWebSearchProvider"] = () => {};
const noopRegisterInteractiveHandler: OpenClawPluginApi["registerInteractiveHandler"] = () => {};
const noopOnConversationBindingResolved: OpenClawPluginApi["onConversationBindingResolved"] =
  () => {};
const noopRegisterCommand: OpenClawPluginApi["registerCommand"] = () => {};
const noopRegisterContextEngine: OpenClawPluginApi["registerContextEngine"] = () => {};
const noopRegisterCompactionProvider: OpenClawPluginApi["registerCompactionProvider"] = () => {};
const noopRegisterMemoryCapability: OpenClawPluginApi["registerMemoryCapability"] = () => {};
const noopRegisterMemoryPromptSection: OpenClawPluginApi["registerMemoryPromptSection"] = () => {};
const noopRegisterMemoryPromptSupplement: OpenClawPluginApi["registerMemoryPromptSupplement"] =
  () => {};
const noopRegisterMemoryCorpusSupplement: OpenClawPluginApi["registerMemoryCorpusSupplement"] =
  () => {};
const noopRegisterMemoryFlushPlan: OpenClawPluginApi["registerMemoryFlushPlan"] = () => {};
const noopRegisterMemoryRuntime: OpenClawPluginApi["registerMemoryRuntime"] = () => {};
const noopRegisterMemoryEmbeddingProvider: OpenClawPluginApi["registerMemoryEmbeddingProvider"] =
  () => {};
const noopOn: OpenClawPluginApi["on"] = () => {};

export function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi {
  const handlers = params.handlers ?? {};
  return {
    config: params.config,
    description: params.description,
    id: params.id,
    logger: params.logger,
    name: params.name,
    on: handlers.on ?? noopOn,
    onConversationBindingResolved:
      handlers.onConversationBindingResolved ?? noopOnConversationBindingResolved,
    pluginConfig: params.pluginConfig,
    registerAutoEnableProbe: handlers.registerAutoEnableProbe ?? noopRegisterAutoEnableProbe,
    registerChannel: handlers.registerChannel ?? noopRegisterChannel,
    registerCli: handlers.registerCli ?? noopRegisterCli,
    registerCliBackend: handlers.registerCliBackend ?? noopRegisterCliBackend,
    registerCommand: handlers.registerCommand ?? noopRegisterCommand,
    registerCompactionProvider:
      handlers.registerCompactionProvider ?? noopRegisterCompactionProvider,
    registerConfigMigration: handlers.registerConfigMigration ?? noopRegisterConfigMigration,
    registerContextEngine: handlers.registerContextEngine ?? noopRegisterContextEngine,
    registerGatewayMethod: handlers.registerGatewayMethod ?? noopRegisterGatewayMethod,
    registerHook: handlers.registerHook ?? noopRegisterHook,
    registerHttpRoute: handlers.registerHttpRoute ?? noopRegisterHttpRoute,
    registerImageGenerationProvider:
      handlers.registerImageGenerationProvider ?? noopRegisterImageGenerationProvider,
    registerInteractiveHandler:
      handlers.registerInteractiveHandler ?? noopRegisterInteractiveHandler,
    registerMediaUnderstandingProvider:
      handlers.registerMediaUnderstandingProvider ?? noopRegisterMediaUnderstandingProvider,
    registerMemoryCapability: handlers.registerMemoryCapability ?? noopRegisterMemoryCapability,
    registerMemoryCorpusSupplement:
      handlers.registerMemoryCorpusSupplement ?? noopRegisterMemoryCorpusSupplement,
    registerMemoryEmbeddingProvider:
      handlers.registerMemoryEmbeddingProvider ?? noopRegisterMemoryEmbeddingProvider,
    registerMemoryFlushPlan: handlers.registerMemoryFlushPlan ?? noopRegisterMemoryFlushPlan,
    registerMemoryPromptSection:
      handlers.registerMemoryPromptSection ?? noopRegisterMemoryPromptSection,
    registerMemoryPromptSupplement:
      handlers.registerMemoryPromptSupplement ?? noopRegisterMemoryPromptSupplement,
    registerMemoryRuntime: handlers.registerMemoryRuntime ?? noopRegisterMemoryRuntime,
    registerMusicGenerationProvider:
      handlers.registerMusicGenerationProvider ?? noopRegisterMusicGenerationProvider,
    registerNodeHostCommand: handlers.registerNodeHostCommand ?? noopRegisterNodeHostCommand,
    registerProvider: handlers.registerProvider ?? noopRegisterProvider,
    registerRealtimeTranscriptionProvider:
      handlers.registerRealtimeTranscriptionProvider ?? noopRegisterRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider:
      handlers.registerRealtimeVoiceProvider ?? noopRegisterRealtimeVoiceProvider,
    registerReload: handlers.registerReload ?? noopRegisterReload,
    registerSecurityAuditCollector:
      handlers.registerSecurityAuditCollector ?? noopRegisterSecurityAuditCollector,
    registerService: handlers.registerService ?? noopRegisterService,
    registerSpeechProvider: handlers.registerSpeechProvider ?? noopRegisterSpeechProvider,
    registerTool: handlers.registerTool ?? noopRegisterTool,
    registerVideoGenerationProvider:
      handlers.registerVideoGenerationProvider ?? noopRegisterVideoGenerationProvider,
    registerWebFetchProvider: handlers.registerWebFetchProvider ?? noopRegisterWebFetchProvider,
    registerWebSearchProvider: handlers.registerWebSearchProvider ?? noopRegisterWebSearchProvider,
    registrationMode: params.registrationMode,
    resolvePath: params.resolvePath,
    rootDir: params.rootDir,
    runtime: params.runtime,
    source: params.source,
    version: params.version,
  };
}
