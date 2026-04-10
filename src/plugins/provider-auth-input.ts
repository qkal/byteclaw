import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import type { OpenClawConfig } from "../config/types.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  normalizeOptionalLowercaseString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  type SecretInputModePromptCopy,
  resolveSecretInputModeForEnvSelection,
} from "./provider-auth-mode.js";
import {
  type SecretRefSetupPromptCopy,
  extractEnvVarFromSourceLabel,
  promptSecretRefForSetup,
  resolveRefFallbackInput,
} from "./provider-auth-ref.js";
import type { SecretInputMode } from "./provider-auth-types.js";

export {
  extractEnvVarFromSourceLabel,
  promptSecretRefForSetup,
  resolveRefFallbackInput,
  type SecretRefSetupPromptCopy,
} from "./provider-auth-ref.js";
export {
  resolveSecretInputModeForEnvSelection,
  type SecretInputModePromptCopy,
} from "./provider-auth-mode.js";

const DEFAULT_KEY_PREVIEW = { head: 4, tail: 4 };

export function normalizeApiKeyInput(raw: string): string {
  const trimmed = normalizeStringifiedOptionalString(raw) ?? "";
  if (!trimmed) {
    return "";
  }

  const assignmentMatch = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  const valuePart = assignmentMatch ? assignmentMatch[1].trim() : trimmed;

  const unquoted =
    valuePart.length >= 2 &&
    ((valuePart.startsWith('"') && valuePart.endsWith('"')) ||
      (valuePart.startsWith("'") && valuePart.endsWith("'")) ||
      (valuePart.startsWith("`") && valuePart.endsWith("`")))
      ? valuePart.slice(1, -1)
      : valuePart;

  const withoutSemicolon = unquoted.endsWith(";") ? unquoted.slice(0, -1) : unquoted;

  return withoutSemicolon.trim();
}

export const validateApiKeyInput = (value: string) =>
  normalizeApiKeyInput(value).length > 0 ? undefined : "Required";

export function formatApiKeyPreview(
  raw: string,
  opts: { head?: number; tail?: number } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "…";
  }
  const head = opts.head ?? DEFAULT_KEY_PREVIEW.head;
  const tail = opts.tail ?? DEFAULT_KEY_PREVIEW.tail;
  if (trimmed.length <= head + tail) {
    const shortHead = Math.min(2, trimmed.length);
    const shortTail = Math.min(2, trimmed.length - shortHead);
    if (shortTail <= 0) {
      return `${trimmed.slice(0, shortHead)}…`;
    }
    return `${trimmed.slice(0, shortHead)}…${trimmed.slice(-shortTail)}`;
  }
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

export function normalizeTokenProviderInput(
  tokenProvider: string | null | undefined,
): string | undefined {
  return normalizeOptionalLowercaseString(tokenProvider);
}

export function normalizeSecretInputModeInput(
  secretInputMode: string | null | undefined,
): SecretInputMode | undefined {
  const normalized = normalizeOptionalLowercaseString(secretInputMode);
  if (normalized === "plaintext" || normalized === "ref") {
    return normalized;
  }
  return undefined;
}

export async function maybeApplyApiKeyFromOption(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  expectedProviders: string[];
  normalize: (value: string) => string;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string | undefined> {
  const tokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  const expectedProviders = params.expectedProviders
    .map((provider) => normalizeTokenProviderInput(provider))
    .filter((provider): provider is string => Boolean(provider));
  if (!params.token || !tokenProvider || !expectedProviders.includes(tokenProvider)) {
    return undefined;
  }
  const apiKey = params.normalize(params.token);
  await params.setCredential(apiKey, params.secretInputMode);
  return apiKey;
}

export async function ensureApiKeyFromOptionEnvOrPrompt(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  expectedProviders: string[];
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
  noteMessage?: string;
  noteTitle?: string;
}): Promise<string> {
  const optionApiKey = await maybeApplyApiKeyFromOption({
    expectedProviders: params.expectedProviders,
    normalize: params.normalize,
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
    token: params.token,
    tokenProvider: params.tokenProvider,
  });
  if (optionApiKey) {
    return optionApiKey;
  }

  if (params.noteMessage) {
    await params.prompter.note(params.noteMessage, params.noteTitle);
  }

  return await ensureApiKeyFromEnvOrPrompt({
    config: params.config,
    env: params.env,
    envLabel: params.envLabel,
    normalize: params.normalize,
    promptMessage: params.promptMessage,
    prompter: params.prompter,
    provider: params.provider,
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
    validate: params.validate,
  });
}

export async function ensureApiKeyFromEnvOrPrompt(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string> {
  const selectedMode = await resolveSecretInputModeForEnvSelection({
    explicitMode: params.secretInputMode,
    prompter: params.prompter,
  });
  const env = params.env ?? process.env;
  const envKey = resolveEnvApiKey(params.provider, env);

  if (selectedMode === "ref") {
    if (typeof params.prompter.select !== "function") {
      const fallback = resolveRefFallbackInput({
        config: params.config,
        env,
        preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
        provider: params.provider,
      });
      await params.setCredential(fallback.ref, selectedMode);
      return fallback.resolvedValue;
    }
    const resolved = await promptSecretRefForSetup({
      config: params.config,
      env,
      preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
      prompter: params.prompter,
      provider: params.provider,
    });
    await params.setCredential(resolved.ref, selectedMode);
    return resolved.resolvedValue;
  }

  if (envKey && selectedMode === "plaintext") {
    const useExisting = await params.prompter.confirm({
      initialValue: true,
      message: `Use existing ${params.envLabel} (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
    });
    if (useExisting) {
      await params.setCredential(envKey.apiKey, selectedMode);
      return envKey.apiKey;
    }
  }

  const key = await params.prompter.text({
    message: params.promptMessage,
    validate: params.validate,
  });
  const apiKey = params.normalize(String(key ?? ""));
  await params.setCredential(apiKey, selectedMode);
  return apiKey;
}
