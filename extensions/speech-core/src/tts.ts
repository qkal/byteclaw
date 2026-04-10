import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { type ChannelId, normalizeChannelId } from "openclaw/plugin-sdk/channel-targets";
import type {
  OpenClawConfig,
  TtsAutoMode,
  TtsConfig,
  TtsMode,
  TtsModelOverrideConfig,
  TtsProvider,
} from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { isVerbose, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  resolveConfigDir,
  resolveUserPath,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-runtime";
import {
  type SpeechModelOverridePolicy,
  type SpeechProviderConfig,
  type SpeechProviderOverrides,
  type SpeechVoiceOption,
  type TtsDirectiveOverrides,
  type TtsDirectiveParseResult,
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
  normalizeTtsAutoMode,
  parseTtsDirectives,
  scheduleCleanup,
  summarizeText,
} from "../api.js";

export type { TtsDirectiveOverrides, TtsDirectiveParseResult };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;

export interface ResolvedTtsConfig {
  auto: TtsAutoMode;
  mode: TtsMode;
  provider: TtsProvider;
  providerSource: "config" | "default";
  summaryModel?: string;
  modelOverrides: ResolvedTtsModelOverrides;
  providerConfigs: Record<string, SpeechProviderConfig>;
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
  rawConfig?: TtsConfig;
  sourceConfig?: OpenClawConfig;
}

interface TtsUserPrefs {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
}

export type ResolvedTtsModelOverrides = SpeechModelOverridePolicy;

export type TtsAttemptReasonCode =
  | "success"
  | "no_provider_registered"
  | "not_configured"
  | "unsupported_for_telephony"
  | "timeout"
  | "provider_error";

export interface TtsProviderAttempt {
  provider: string;
  outcome: "success" | "skipped" | "failed";
  reasonCode: TtsAttemptReasonCode;
  latencyMs?: number;
  error?: string;
}

export interface TtsResult {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
}

export interface TtsSynthesisResult {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
}

export interface TtsTelephonyResult {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  sampleRate?: number;
}

interface TtsStatusEntry {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  latencyMs?: number;
  error?: string;
}

let lastTtsAttempt: TtsStatusEntry | undefined;

function resolveConfiguredTtsAutoMode(raw: TtsConfig): TtsAutoMode {
  return normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
}

function normalizeConfiguredSpeechProviderId(
  providerId: string | undefined,
): TtsProvider | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

function resolveModelOverridePolicy(
  overrides: TtsModelOverrideConfig | undefined,
): ResolvedTtsModelOverrides {
  const enabled = overrides?.enabled ?? true;
  if (!enabled) {
    return {
      allowModelId: false,
      allowNormalization: false,
      allowProvider: false,
      allowSeed: false,
      allowText: false,
      allowVoice: false,
      allowVoiceSettings: false,
      enabled: false,
    };
  }
  const allow = (value: boolean | undefined, defaultValue = true) => value ?? defaultValue;
  return {
    allowModelId: allow(overrides?.allowModelId),
    allowNormalization: allow(overrides?.allowNormalization),
    allowProvider: allow(overrides?.allowProvider, false),
    allowSeed: allow(overrides?.allowSeed),
    allowText: allow(overrides?.allowText),
    allowVoice: allow(overrides?.allowVoice),
    allowVoiceSettings: allow(overrides?.allowVoiceSettings),
    enabled: true,
  };
}

function sortSpeechProvidersForAutoSelection(cfg?: OpenClawConfig) {
  return listSpeechProviders(cfg).toSorted((left, right) => {
    const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function _resolveRegistryDefaultSpeechProviderId(cfg?: OpenClawConfig): TtsProvider {
  return sortSpeechProvidersForAutoSelection(cfg)[0]?.id ?? "";
}

function asProviderConfig(value: unknown): SpeechProviderConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SpeechProviderConfig)
    : {};
}

function asProviderConfigMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveRawProviderConfig(
  raw: TtsConfig | undefined,
  providerId: string,
): SpeechProviderConfig {
  if (!raw) {
    return {};
  }
  const rawProviders = asProviderConfigMap(raw.providers);
  const direct = rawProviders[providerId] ?? (raw as Record<string, unknown>)[providerId];
  return asProviderConfig(direct);
}

function resolveLazyProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
): SpeechProviderConfig {
  const canonical =
    normalizeConfiguredSpeechProviderId(providerId) ?? normalizeLowercaseStringOrEmpty(providerId);
  const existing = config.providerConfigs[canonical];
  const effectiveCfg = cfg ?? config.sourceConfig;
  if (existing && !effectiveCfg) {
    return existing;
  }
  const rawConfig = resolveRawProviderConfig(config.rawConfig, canonical);
  const resolvedProvider = getSpeechProvider(canonical, effectiveCfg);
  const next =
    effectiveCfg && resolvedProvider?.resolveConfig
      ? resolvedProvider.resolveConfig({
          cfg: effectiveCfg,
          rawConfig: {
            ...(config.rawConfig as Record<string, unknown> | undefined),
            providers: asProviderConfigMap(config.rawConfig?.providers),
          },
          timeoutMs: config.timeoutMs,
        })
      : rawConfig;
  config.providerConfigs[canonical] = next;
  return next;
}

function collectDirectProviderConfigEntries(raw: TtsConfig): Record<string, SpeechProviderConfig> {
  const entries: Record<string, SpeechProviderConfig> = {};
  const rawProviders = asProviderConfigMap(raw.providers);
  for (const [providerId, value] of Object.entries(rawProviders)) {
    const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
    entries[normalized] = asProviderConfig(value);
  }
  const reservedKeys = new Set([
    "auto",
    "enabled",
    "maxTextLength",
    "mode",
    "modelOverrides",
    "prefsPath",
    "provider",
    "providers",
    "summaryModel",
    "timeoutMs",
  ]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (reservedKeys.has(key)) {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const normalized = normalizeConfiguredSpeechProviderId(key) ?? key;
    entries[normalized] ??= asProviderConfig(value);
  }
  return entries;
}

export function getResolvedSpeechProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
): SpeechProviderConfig {
  const canonical =
    canonicalizeSpeechProviderId(providerId, cfg) ??
    normalizeConfiguredSpeechProviderId(providerId) ??
    normalizeLowercaseStringOrEmpty(providerId);
  return resolveLazyProviderConfig(config, canonical, cfg);
}

export function resolveTtsConfig(cfg: OpenClawConfig): ResolvedTtsConfig {
  const raw: TtsConfig = cfg.messages?.tts ?? {};
  const providerSource = raw.provider ? "config" : "default";
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auto = resolveConfiguredTtsAutoMode(raw);
  return {
    auto,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    mode: raw.mode ?? "final",
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    prefsPath: raw.prefsPath,
    provider:
      normalizeConfiguredSpeechProviderId(raw.provider) ??
      (providerSource === "config" ? (normalizeOptionalLowercaseString(raw.provider) ?? "") : ""),
    providerConfigs: collectDirectProviderConfigEntries(raw),
    providerSource,
    rawConfig: raw,
    sourceConfig: cfg,
    summaryModel: normalizeOptionalString(raw.summaryModel),
    timeoutMs,
  };
}

export function resolveTtsPrefsPath(config: ResolvedTtsConfig): string {
  return resolveTtsPrefsPathValue(config.prefsPath);
}

function resolveTtsAutoModeFromPrefs(prefs: TtsUserPrefs): TtsAutoMode | undefined {
  const auto = normalizeTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}

export function resolveTtsAutoMode(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
}): TtsAutoMode {
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return sessionAuto;
  }
  const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(params.prefsPath));
  if (prefsAuto) {
    return prefsAuto;
  }
  return params.config.auto;
}

function resolveEffectiveTtsAutoState(params: { cfg: OpenClawConfig; sessionAuto?: string }): {
  autoMode: TtsAutoMode;
  prefsPath: string;
} {
  const raw: TtsConfig = params.cfg.messages?.tts ?? {};
  const prefsPath = resolveTtsPrefsPathValue(raw.prefsPath);
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return { autoMode: sessionAuto, prefsPath };
  }
  const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(prefsPath));
  if (prefsAuto) {
    return { autoMode: prefsAuto, prefsPath };
  }
  return {
    autoMode: resolveConfiguredTtsAutoMode(raw),
    prefsPath,
  };
}

export function buildTtsSystemPromptHint(cfg: OpenClawConfig): string | undefined {
  const { autoMode, prefsPath } = resolveEffectiveTtsAutoState({ cfg });
  if (autoMode === "off") {
    return undefined;
  }
  const _config = resolveTtsConfig(cfg);
  const maxLength = getTtsMaxLength(prefsPath);
  const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
  const autoHint =
    autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : (autoMode === "tagged"
        ? "Only use TTS when you include [[tts]] or [[tts:text]] tags."
        : undefined);
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    `Keep spoken text ≤${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

function updatePrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

export function isTtsEnabled(
  config: ResolvedTtsConfig,
  prefsPath: string,
  sessionAuto?: string,
): boolean {
  return resolveTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updatePrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  const prefs = readPrefs(prefsPath);
  const prefsProvider =
    canonicalizeSpeechProviderId(prefs.tts?.provider) ??
    normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
  if (prefsProvider) {
    return prefsProvider;
  }
  if (config.providerSource === "config") {
    return normalizeConfiguredSpeechProviderId(config.provider) ?? config.provider;
  }

  for (const provider of sortSpeechProvidersForAutoSelection()) {
    if (
      provider.isConfigured({
        providerConfig: config.providerConfigs[provider.id] ?? {},
        timeoutMs: config.timeoutMs,
      })
    ) {
      return provider.id;
    }
  }
  return config.provider;
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider: canonicalizeSpeechProviderId(provider) ?? provider };
  });
}

export function resolveExplicitTtsOverrides(params: {
  cfg: OpenClawConfig;
  prefsPath?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
}): TtsDirectiveOverrides {
  const providerInput = params.provider?.trim();
  const modelId = params.modelId?.trim();
  const voiceId = params.voiceId?.trim();
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const selectedProvider =
    canonicalizeSpeechProviderId(providerInput, params.cfg) ??
    (modelId || voiceId ? getTtsProvider(config, prefsPath) : undefined);

  if (providerInput && !selectedProvider) {
    throw new Error(`Unknown TTS provider "${providerInput}".`);
  }

  if (!modelId && !voiceId) {
    return selectedProvider ? { provider: selectedProvider } : {};
  }

  if (!selectedProvider) {
    throw new Error("TTS model or voice overrides require a resolved provider.");
  }

  const provider = getSpeechProvider(selectedProvider, params.cfg);
  if (!provider) {
    throw new Error(`speech provider ${selectedProvider} is not registered`);
  }
  if (!provider.resolveTalkOverrides) {
    throw new Error(
      `TTS provider "${selectedProvider}" does not support model or voice overrides.`,
    );
  }

  const providerOverrides = provider.resolveTalkOverrides({
    params: {
      ...(voiceId ? { voiceId } : {}),
      ...(modelId ? { modelId } : {}),
    },
    talkProviderConfig: {},
  });
  if ((voiceId || modelId) && (!providerOverrides || Object.keys(providerOverrides).length === 0)) {
    throw new Error(
      `TTS provider "${selectedProvider}" ignored the requested model or voice overrides.`,
    );
  }

  const overridesRecord = providerOverrides as SpeechProviderOverrides;
  return {
    provider: selectedProvider,
    providerOverrides: {
      [provider.id]: overridesRecord,
    },
  };
}

export function getTtsMaxLength(prefsPath: string): number {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function isSummarizationEnabled(prefsPath: string): boolean {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return lastTtsAttempt;
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  lastTtsAttempt = entry;
}

const OPUS_CHANNELS = new Set(["telegram", "feishu", "whatsapp", "matrix", "discord"]);

function resolveChannelId(channel: string | undefined): ChannelId | null {
  return channel ? normalizeChannelId(channel) : null;
}

export function resolveTtsProviderOrder(primary: TtsProvider, cfg?: OpenClawConfig): TtsProvider[] {
  const normalizedPrimary = canonicalizeSpeechProviderId(primary, cfg) ?? primary;
  const ordered = new Set<TtsProvider>([normalizedPrimary]);
  for (const provider of sortSpeechProvidersForAutoSelection(cfg)) {
    const normalized = provider.id;
    if (normalized !== normalizedPrimary) {
      ordered.add(normalized);
    }
  }
  return [...ordered];
}

export function isTtsProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
  cfg?: OpenClawConfig,
): boolean {
  const resolvedProvider = getSpeechProvider(provider, cfg);
  if (!resolvedProvider) {
    return false;
  }
  return (
    resolvedProvider.isConfigured({
      cfg,
      providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, cfg),
      timeoutMs: config.timeoutMs,
    }) ?? false
  );
}

function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${redactSensitiveText(error.message)}`;
}

function sanitizeTtsErrorForLog(err: unknown): string {
  const raw = formatErrorMessage(err);
  return redactSensitiveText(raw).replace(/\r/g, String.raw`\r`).replace(/\n/g, String.raw`\n`).replace(/\t/g, String.raw`\t`);
}

function buildTtsFailureResult(
  errors: string[],
  attemptedProviders?: string[],
  attempts?: TtsProviderAttempt[],
): {
  success: false;
  error: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
} {
  return {
    attemptedProviders,
    attempts,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
    success: false,
  };
}

type TtsProviderReadyResolution =
  | {
      kind: "ready";
      provider: NonNullable<ReturnType<typeof getSpeechProvider>>;
      providerConfig: SpeechProviderConfig;
    }
  | {
      kind: "skip";
      reasonCode: "no_provider_registered" | "not_configured" | "unsupported_for_telephony";
      message: string;
    };

function resolveReadySpeechProvider(params: {
  provider: TtsProvider;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  requireTelephony?: boolean;
}): TtsProviderReadyResolution {
  const resolvedProvider = getSpeechProvider(params.provider, params.cfg);
  if (!resolvedProvider) {
    return {
      kind: "skip",
      message: `${params.provider}: no provider registered`,
      reasonCode: "no_provider_registered",
    };
  }
  const providerConfig = getResolvedSpeechProviderConfig(
    params.config,
    resolvedProvider.id,
    params.cfg,
  );
  if (
    !resolvedProvider.isConfigured({
      cfg: params.cfg,
      providerConfig,
      timeoutMs: params.config.timeoutMs,
    })
  ) {
    return {
      kind: "skip",
      message: `${params.provider}: not configured`,
      reasonCode: "not_configured",
    };
  }
  if (params.requireTelephony && !resolvedProvider.synthesizeTelephony) {
    return {
      kind: "skip",
      message: `${params.provider}: unsupported for telephony`,
      reasonCode: "unsupported_for_telephony",
    };
  }
  return {
    kind: "ready",
    provider: resolvedProvider,
    providerConfig,
  };
}

function resolveTtsRequestSetup(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  providerOverride?: TtsProvider;
  disableFallback?: boolean;
}):
  | {
      config: ResolvedTtsConfig;
      providers: TtsProvider[];
    }
  | {
      error: string;
    } {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = getTtsProvider(config, prefsPath);
  const provider =
    canonicalizeSpeechProviderId(params.providerOverride, params.cfg) ?? userProvider;
  return {
    config,
    providers: params.disableFallback ? [provider] : resolveTtsProviderOrder(provider, params.cfg),
  };
}

export async function textToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
}): Promise<TtsResult> {
  const synthesis = await synthesizeSpeech(params);
  if (!synthesis.success || !synthesis.audioBuffer || !synthesis.fileExtension) {
    return {
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
      error: synthesis.error ?? "TTS conversion failed",
      success: false,
    };
  }

  const tempRoot = resolvePreferredOpenClawTmpDir();
  mkdirSync(tempRoot, { mode: 0o700, recursive: true });
  const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
  const audioPath = path.join(tempDir, `voice-${Date.now()}${synthesis.fileExtension}`);
  writeFileSync(audioPath, synthesis.audioBuffer);
  scheduleCleanup(tempDir);

  return {
    attemptedProviders: synthesis.attemptedProviders,
    attempts: synthesis.attempts,
    audioPath,
    fallbackFrom: synthesis.fallbackFrom,
    latencyMs: synthesis.latencyMs,
    outputFormat: synthesis.outputFormat,
    provider: synthesis.provider,
    success: true,
    voiceCompatible: synthesis.voiceCompatible,
  };
}

export async function synthesizeSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
}): Promise<TtsSynthesisResult> {
  const setup = resolveTtsRequestSetup({
    cfg: params.cfg,
    disableFallback: params.disableFallback,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    text: params.text,
  });
  if ("error" in setup) {
    return { error: setup.error, success: false };
  }

  const { config, providers } = setup;
  const channelId = resolveChannelId(params.channel);
  const target = channelId && OPUS_CHANNELS.has(channelId) ? "voice-note" : "audio-file";

  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0];
  logVerbose(
    `TTS: starting with provider ${primaryProvider}, fallbacks: ${providers.slice(1).join(", ") || "none"}`,
  );

  for (const provider of providers) {
    attemptedProviders.push(provider);
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        cfg: params.cfg,
        config,
        provider,
      });
      if (resolvedProvider.kind === "skip") {
        errors.push(resolvedProvider.message);
        attempts.push({
          error: resolvedProvider.message,
          outcome: "skipped",
          provider,
          reasonCode: resolvedProvider.reasonCode,
        });
        logVerbose(`TTS: provider ${provider} skipped (${resolvedProvider.message})`);
        continue;
      }
      const synthesis = await resolvedProvider.provider.synthesize({
        cfg: params.cfg,
        providerConfig: resolvedProvider.providerConfig,
        providerOverrides: params.overrides?.providerOverrides?.[resolvedProvider.provider.id],
        target,
        text: params.text,
        timeoutMs: config.timeoutMs,
      });
      const latencyMs = Date.now() - providerStart;
      attempts.push({
        latencyMs,
        outcome: "success",
        provider,
        reasonCode: "success",
      });
      return {
        attemptedProviders,
        attempts,
        audioBuffer: synthesis.audioBuffer,
        fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
        fileExtension: synthesis.fileExtension,
        latencyMs,
        outputFormat: synthesis.outputFormat,
        provider,
        success: true,
        voiceCompatible: synthesis.voiceCompatible,
      };
    } catch (error) {
      const errorMsg = formatTtsProviderError(provider, error);
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode:
          error instanceof Error && error.name === "AbortError" ? "timeout" : "provider_error",
        latencyMs,
        error: errorMsg,
      });
      const rawError = sanitizeTtsErrorForLog(error);
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `TTS: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`TTS: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts);
}

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
}): Promise<TtsTelephonyResult> {
  const setup = resolveTtsRequestSetup({
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    text: params.text,
  });
  if ("error" in setup) {
    return { error: setup.error, success: false };
  }

  const { config, providers } = setup;
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0];
  logVerbose(
    `TTS telephony: starting with provider ${primaryProvider}, fallbacks: ${providers.slice(1).join(", ") || "none"}`,
  );

  for (const provider of providers) {
    attemptedProviders.push(provider);
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        cfg: params.cfg,
        config,
        provider,
        requireTelephony: true,
      });
      if (resolvedProvider.kind === "skip") {
        errors.push(resolvedProvider.message);
        attempts.push({
          error: resolvedProvider.message,
          outcome: "skipped",
          provider,
          reasonCode: resolvedProvider.reasonCode,
        });
        logVerbose(`TTS telephony: provider ${provider} skipped (${resolvedProvider.message})`);
        continue;
      }
      const synthesizeTelephony = resolvedProvider.provider.synthesizeTelephony as NonNullable<
        typeof resolvedProvider.provider.synthesizeTelephony
      >;
      const synthesis = await synthesizeTelephony({
        cfg: params.cfg,
        providerConfig: resolvedProvider.providerConfig,
        text: params.text,
        timeoutMs: config.timeoutMs,
      });
      const latencyMs = Date.now() - providerStart;
      attempts.push({
        latencyMs,
        outcome: "success",
        provider,
        reasonCode: "success",
      });

      return {
        attemptedProviders,
        attempts,
        audioBuffer: synthesis.audioBuffer,
        fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
        latencyMs,
        outputFormat: synthesis.outputFormat,
        provider,
        sampleRate: synthesis.sampleRate,
        success: true,
      };
    } catch (error) {
      const errorMsg = formatTtsProviderError(provider, error);
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode:
          error instanceof Error && error.name === "AbortError" ? "timeout" : "provider_error",
        latencyMs,
        error: errorMsg,
      });
      const rawError = sanitizeTtsErrorForLog(error);
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `TTS telephony: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`TTS telephony: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts);
}

export async function listSpeechVoices(params: {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const provider = canonicalizeSpeechProviderId(params.provider, params.cfg);
  if (!provider) {
    throw new Error("speech provider id is required");
  }
  const config = params.config ?? (params.cfg ? resolveTtsConfig(params.cfg) : undefined);
  if (!config) {
    throw new Error(`speech provider ${provider} requires cfg or resolved config`);
  }
  const resolvedProvider = getSpeechProvider(provider, params.cfg);
  if (!resolvedProvider) {
    throw new Error(`speech provider ${provider} is not registered`);
  }
  if (!resolvedProvider.listVoices) {
    throw new Error(`speech provider ${provider} does not support voice listing`);
  }
  return await resolvedProvider.listVoices({
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    cfg: params.cfg,
    providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, params.cfg),
  });
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
}): Promise<ReplyPayload> {
  if (params.payload.isCompactionNotice) {
    return params.payload;
  }
  const { autoMode, prefsPath } = resolveEffectiveTtsAutoState({
    cfg: params.cfg,
    sessionAuto: params.ttsAuto,
  });
  if (autoMode === "off") {
    return params.payload;
  }
  const config = resolveTtsConfig(params.cfg);

  const reply = resolveSendableOutboundReplyParts(params.payload);
  const {text} = reply;
  const directives = parseTtsDirectives(text, config.modelOverrides, {
    cfg: params.cfg,
    providerConfigs: config.providerConfigs,
  });
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
  }

  if (isVerbose()) {
    const effectiveProvider = directives.overrides?.provider
      ? (canonicalizeSpeechProviderId(directives.overrides.provider, params.cfg) ??
        getTtsProvider(config, prefsPath))
      : getTtsProvider(config, prefsPath);
    logVerbose(
      `TTS: auto mode enabled (${autoMode}), channel=${params.channel}, selected provider=${effectiveProvider}, config.provider=${config.provider}, config.providerSource=${config.providerSource}`,
    );
  }

  const {cleanedText} = directives;
  const trimmedCleaned = cleanedText.trim();
  const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
  const ttsText = directives.ttsText?.trim() || visibleText;

  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };

  if (autoMode === "tagged" && !directives.hasDirective) {
    return nextPayload;
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return nextPayload;
  }

  const mode = config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") {
    return nextPayload;
  }

  if (!ttsText.trim()) {
    return nextPayload;
  }
  if (reply.hasMedia) {
    return nextPayload;
  }
  if (text.includes("MEDIA:")) {
    return nextPayload;
  }
  if (ttsText.trim().length < 10) {
    return nextPayload;
  }

  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = ttsText.trim();
  let wasSummarized = false;

  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      logVerbose(
        `TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    } else {
      try {
        const summary = await summarizeText({
          cfg: params.cfg,
          config,
          targetLength: maxLength,
          text: textForAudio,
          timeoutMs: config.timeoutMs,
        });
        textForAudio = summary.summary;
        wasSummarized = true;
        if (textForAudio.length > config.maxTextLength) {
          logVerbose(
            `TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`,
          );
          textForAudio = `${textForAudio.slice(0, config.maxTextLength - 3)}...`;
        }
      } catch (error) {
        const error = error as Error;
        logVerbose(`TTS: summarization failed, truncating instead: ${error.message}`);
        textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
      }
    }
  }

  textForAudio = stripMarkdown(textForAudio).trim();
  if (textForAudio.length < 10) {
    return nextPayload;
  }

  const ttsStart = Date.now();
  const result = await textToSpeech({
    cfg: params.cfg,
    channel: params.channel,
    overrides: directives.overrides,
    prefsPath,
    text: textForAudio,
  });

  if (result.success && result.audioPath) {
    lastTtsAttempt = {
      attemptedProviders: result.attemptedProviders,
      attempts: result.attempts,
      fallbackFrom: result.fallbackFrom,
      latencyMs: result.latencyMs,
      provider: result.provider,
      success: true,
      summarized: wasSummarized,
      textLength: text.length,
      timestamp: Date.now(),
    };

    const channelId = resolveChannelId(params.channel);
    const shouldVoice =
      channelId !== null && OPUS_CHANNELS.has(channelId) && result.voiceCompatible === true;
    return {
      ...nextPayload,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
      mediaUrl: result.audioPath,
    };
  }

  lastTtsAttempt = {
    attemptedProviders: result.attemptedProviders,
    attempts: result.attempts,
    error: result.error,
    success: false,
    summarized: wasSummarized,
    textLength: text.length,
    timestamp: Date.now(),
  };

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return nextPayload;
}

export const _test = {
  formatTtsProviderError,
  getResolvedSpeechProviderConfig,
  parseTtsDirectives,
  resolveModelOverridePolicy,
  sanitizeTtsErrorForLog,
  summarizeText,
};
