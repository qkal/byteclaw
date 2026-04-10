import { loadConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../tts/provider-registry.js";
import {
  getResolvedSpeechProviderConfig,
  getTtsProvider,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveExplicitTtsOverrides,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setTtsEnabled,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const ttsHandlers: GatewayRequestHandlers = {
  "tts.convert": async ({ params, respond }) => {
    const text = normalizeOptionalString(params.text) ?? "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const channel = normalizeOptionalString(params.channel);
      const providerRaw = normalizeOptionalString(params.provider);
      const modelId = normalizeOptionalString(params.modelId);
      const voiceId = normalizeOptionalString(params.voiceId);
      let overrides;
      try {
        overrides = resolveExplicitTtsOverrides({
          cfg,
          modelId,
          provider: providerRaw,
          voiceId,
        });
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(error)));
        return;
      }
      const result = await textToSpeech({
        cfg,
        channel,
        disableFallback: Boolean(overrides.provider || modelId || voiceId),
        overrides,
        text,
      });
      if (result.success && result.audioPath) {
        respond(true, {
          audioPath: result.audioPath,
          outputFormat: result.outputFormat,
          provider: result.provider,
          voiceCompatible: result.voiceCompatible,
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS conversion failed"),
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "tts.disable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, false);
      respond(true, { enabled: false });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "tts.enable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, true);
      respond(true, { enabled: true });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "tts.providers": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      respond(true, {
        active: getTtsProvider(config, prefsPath),
        providers: listSpeechProviders(cfg).map((provider) => ({
          id: provider.id,
          name: provider.label,
          configured: provider.isConfigured({
            cfg,
            providerConfig: getResolvedSpeechProviderConfig(config, provider.id, cfg),
            timeoutMs: config.timeoutMs,
          }),
          models: [...(provider.models ?? [])],
          voices: [...(provider.voices ?? [])],
        })),
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "tts.setProvider": async ({ params, respond }) => {
    const cfg = loadConfig();
    const provider = canonicalizeSpeechProviderId(
      normalizeOptionalString(params.provider) ?? "",
      cfg,
    );
    if (!provider || !getSpeechProvider(provider, cfg)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Invalid provider. Use a registered TTS provider id.",
        ),
      );
      return;
    }
    try {
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsProvider(prefsPath, provider);
      respond(true, { provider });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "tts.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const provider = getTtsProvider(config, prefsPath);
      const autoMode = resolveTtsAutoMode({ config, prefsPath });
      const fallbackProviders = resolveTtsProviderOrder(provider, cfg)
        .slice(1)
        .filter((candidate) => isTtsProviderConfigured(config, candidate, cfg));
      const providerStates = listSpeechProviders(cfg).map((candidate) => ({
        configured: candidate.isConfigured({
          cfg,
          providerConfig: getResolvedSpeechProviderConfig(config, candidate.id, cfg),
          timeoutMs: config.timeoutMs,
        }),
        id: candidate.id,
        label: candidate.label,
      }));
      respond(true, {
        auto: autoMode,
        enabled: isTtsEnabled(config, prefsPath),
        fallbackProvider: fallbackProviders[0] ?? null,
        fallbackProviders,
        prefsPath,
        provider,
        providerStates,
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
};
