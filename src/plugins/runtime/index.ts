import { resolveStateDir } from "../../config/paths.js";
import {
  generateImage as generateRuntimeImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import {
  generateMusic as generateRuntimeMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import { RequestScopedSubagentRuntimeError } from "../../plugin-sdk/error-runtime.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import {
  generateVideo as generateRuntimeVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";
import type { PluginRuntime } from "./types.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../tts/tts.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("../../media-understanding/runtime.js"),
);
const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  return {
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

function createRuntimeImageGeneration(): PluginRuntime["imageGeneration"] {
  return {
    generate: (params) => generateRuntimeImage(params),
    listProviders: (params) => listRuntimeImageGenerationProviders(params),
  };
}

function createRuntimeVideoGeneration(): PluginRuntime["videoGeneration"] {
  return {
    generate: (params) => generateRuntimeVideo(params),
    listProviders: (params) => listRuntimeVideoGenerationProviders(params),
  };
}

function createRuntimeMusicGeneration(): PluginRuntime["musicGeneration"] {
  return {
    generate: (params) => generateRuntimeMusic(params),
    listProviders: (params) => listRuntimeMusicGenerationProviders(params),
  };
}

function createRuntimeModelAuth(): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const getRuntimeAuthForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getRuntimeAuthForModel,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveApiKeyForProvider,
  );
  return {
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        cfg: params.cfg,
        model: params.model,
      }),
    getRuntimeAuthForModel: (params) =>
      getRuntimeAuthForModel({
        cfg: params.cfg,
        model: params.model,
        workspaceDir: params.workspaceDir,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        cfg: params.cfg,
        provider: params.provider,
      }),
  };
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new RequestScopedSubagentRuntimeError();
  };
  return {
    deleteSession: unavailable,
    getSession: unavailable,
    getSessionMessages: unavailable,
    run: unavailable,
    waitForRun: unavailable,
  };
}

// ── Process-global gateway subagent runtime ─────────────────────────
// The gateway creates a real subagent runtime during startup, but gateway-owned
// Plugin registries may be loaded (and cached) before the gateway path runs.
// A process-global holder lets explicitly gateway-bindable runtimes resolve the
// Active gateway subagent dynamically without changing the default behavior for
// Ordinary plugin runtimes.

const GATEWAY_SUBAGENT_SYMBOL: unique symbol = Symbol.for(
  "openclaw.plugin.gatewaySubagentRuntime",
) as unknown as typeof GATEWAY_SUBAGENT_SYMBOL;

interface GatewaySubagentState {
  subagent: PluginRuntime["subagent"] | undefined;
}

const gatewaySubagentState = resolveGlobalSingleton<GatewaySubagentState>(
  GATEWAY_SUBAGENT_SYMBOL,
  () => ({
    subagent: undefined,
  }),
);

/**
 * Set the process-global gateway subagent runtime.
 * Called during gateway startup so that gateway-bindable plugin runtimes can
 * resolve subagent methods dynamically even when their registry was cached
 * before the gateway finished loading plugins.
 */
export function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void {
  gatewaySubagentState.subagent = subagent;
}

/**
 * Reset the process-global gateway subagent runtime.
 * Used by tests to avoid leaking gateway state across module reloads.
 */
export function clearGatewaySubagentRuntime(): void {
  gatewaySubagentState.subagent = undefined;
}

/**
 * Create a late-binding subagent that resolves to:
 * 1. An explicitly provided subagent (from runtimeOptions), OR
 * 2. The process-global gateway subagent when the caller explicitly opts in, OR
 * 3. The unavailable fallback (throws with a clear error message).
 */
function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
  allowGatewaySubagentBinding = false,
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;
  }

  const unavailable = createUnavailableSubagentRuntime();
  if (!allowGatewaySubagentBinding) {
    return unavailable;
  }

  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}

export interface CreatePluginRuntimeOptions {
  subagent?: PluginRuntime["subagent"];
  allowGatewaySubagentBinding?: boolean;
}

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const taskFlow = createRuntimeTaskFlow();
  const tasks = createRuntimeTasks({
    legacyTaskFlow: taskFlow,
  });
  const runtime = {
    // Sourced from the shared OpenClaw version resolver (#52899) so plugins
    // Always see the same version the CLI reports, avoiding API-version drift.
    agent: createRuntimeAgent(),
    channel: createRuntimeChannel(),
    config: createRuntimeConfig(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    media: createRuntimeMedia(),
    state: { resolveStateDir },
    subagent: createLateBindingSubagent(
      _options.subagent,
      _options.allowGatewaySubagentBinding === true,
    ),
    system: createRuntimeSystem(),
    taskFlow,
    tasks,
    version: VERSION,
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
  } satisfies Omit<
    PluginRuntime,
    | "tts"
    | "mediaUnderstanding"
    | "stt"
    | "modelAuth"
    | "imageGeneration"
    | "videoGeneration"
    | "musicGeneration"
  > &
    Partial<
      Pick<
        PluginRuntime,
        | "tts"
        | "mediaUnderstanding"
        | "stt"
        | "modelAuth"
        | "imageGeneration"
        | "videoGeneration"
        | "musicGeneration"
      >
    >;

  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "stt", () => ({
    transcribeAudioFile: mediaUnderstanding.transcribeAudioFile,
  }));
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
  defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);
  defineCachedValue(runtime, "videoGeneration", createRuntimeVideoGeneration);
  defineCachedValue(runtime, "musicGeneration", createRuntimeMusicGeneration);

  return runtime as PluginRuntime;
}

export type { PluginRuntime } from "./types.js";
