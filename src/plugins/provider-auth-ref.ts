import type { OpenClawConfig } from "../config/types.js";
import { type SecretRef, isValidEnvSecretRefId } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { encodeJsonPointerToken } from "../secrets/json-pointer.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  resolveDefaultSecretProviderAlias,
} from "../secrets/ref-contract.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import type { WizardPrompter } from "../wizard/prompts.js";

let secretResolvePromise: Promise<typeof import("../secrets/resolve.js")> | undefined;

function loadSecretResolve() {
  secretResolvePromise ??= import("../secrets/resolve.js");
  return secretResolvePromise;
}

const ENV_SOURCE_LABEL_RE = /(?:^|:\s)([A-Z][A-Z0-9_]*)$/;

type SecretRefChoice = "env" | "provider"; // Pragma: allowlist secret

export interface SecretRefSetupPromptCopy {
  sourceMessage?: string;
  envVarMessage?: string;
  envVarPlaceholder?: string;
  envVarFormatError?: string;
  envVarMissingError?: (envVar: string) => string;
  noProvidersMessage?: string;
  envValidatedMessage?: (envVar: string) => string;
  providerValidatedMessage?: (provider: string, id: string, source: "file" | "exec") => string;
}

export function extractEnvVarFromSourceLabel(source: string): string | undefined {
  const match = ENV_SOURCE_LABEL_RE.exec(source.trim());
  return match?.[1];
}

function resolveDefaultProviderEnvVar(provider: string): string | undefined {
  const envVars = getProviderEnvVars(provider);
  return envVars?.find((candidate) => normalizeOptionalString(candidate) !== undefined);
}

function resolveDefaultFilePointerId(provider: string): string {
  return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}

export function resolveRefFallbackInput(params: {
  config: OpenClawConfig;
  provider: string;
  preferredEnvVar?: string;
  env?: NodeJS.ProcessEnv;
}): { ref: SecretRef; resolvedValue: string } {
  const fallbackEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider);
  if (!fallbackEnvVar) {
    throw new Error(
      `No default environment variable mapping found for provider "${params.provider}". Set a provider-specific env var, or re-run setup in an interactive terminal to configure a ref.`,
    );
  }
  const env = params.env ?? process.env;
  const value = normalizeOptionalString(env[fallbackEnvVar]);
  if (!value) {
    throw new Error(
      `Environment variable "${fallbackEnvVar}" is required for --secret-input-mode ref in non-interactive setup.`,
    );
  }
  return {
    ref: {
      id: fallbackEnvVar,
      provider: resolveDefaultSecretProviderAlias(params.config, "env", {
        preferFirstProviderForSource: true,
      }),
      source: "env",
    },
    resolvedValue: value,
  };
}

async function promptEnvSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  defaultEnvVar: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const env = params.env ?? process.env;
  const envVarRaw = await params.prompter.text({
    initialValue: params.defaultEnvVar || undefined,
    message: params.copy?.envVarMessage ?? "Environment variable name",
    placeholder: params.copy?.envVarPlaceholder ?? "OPENAI_API_KEY",
    validate: (value) => {
      const candidate = value.trim();
      if (!isValidEnvSecretRefId(candidate)) {
        return (
          params.copy?.envVarFormatError ??
          'Use an env var name like "OPENAI_API_KEY" (uppercase letters, numbers, underscores).'
        );
      }
      if (!normalizeOptionalString(env[candidate])) {
        return (
          params.copy?.envVarMissingError?.(candidate) ??
          `Environment variable "${candidate}" is missing or empty in this session.`
        );
      }
      return undefined;
    },
  });
  const envCandidate = normalizeStringifiedOptionalString(envVarRaw) ?? "";
  const envVar =
    envCandidate && isValidEnvSecretRefId(envCandidate) ? envCandidate : params.defaultEnvVar;
  if (!envVar) {
    throw new Error(
      `No valid environment variable name provided for provider "${params.provider}".`,
    );
  }
  const resolvedValue = normalizeOptionalString(env[envVar]);
  if (!resolvedValue) {
    throw new Error(`Environment variable "${envVar}" is missing or empty in this session.`);
  }
  const ref: SecretRef = {
    id: envVar,
    provider: resolveDefaultSecretProviderAlias(params.config, "env", {
      preferFirstProviderForSource: true,
    }),
    source: "env",
  };
  await params.prompter.note(
    params.copy?.envValidatedMessage?.(envVar) ??
      `Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`,
    "Reference validated",
  );
  return { ref, resolvedValue };
}

async function promptProviderSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  defaultFilePointer: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(
    ([, provider]) => provider?.source === "file" || provider?.source === "exec",
  );
  if (externalProviders.length === 0) {
    await params.prompter.note(
      params.copy?.noProvidersMessage ??
        "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.",
      "No providers configured",
    );
    throw new Error("retry");
  }

  const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", {
    preferFirstProviderForSource: true,
  });
  const selectedProvider = await params.prompter.select<string>({
    initialValue:
      externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ??
      externalProviders[0]?.[0],
    message: "Select secret provider",
    options: externalProviders.map(([providerName, provider]) => ({
      hint: provider?.source === "exec" ? "Exec provider" : "File provider",
      label: providerName,
      value: providerName,
    })),
  });
  const providerEntry = params.config.secrets?.providers?.[selectedProvider];
  if (!providerEntry || (providerEntry.source !== "file" && providerEntry.source !== "exec")) {
    await params.prompter.note(
      `Provider "${selectedProvider}" is not a file/exec provider.`,
      "Invalid provider",
    );
    throw new Error("retry");
  }

  const idPrompt =
    providerEntry.source === "file"
      ? "Secret id (JSON pointer for json mode, or 'value' for singleValue mode)"
      : "Secret id for the exec provider";
  const idDefault =
    providerEntry.source === "file"
      ? (providerEntry.mode === "singleValue"
        ? "value"
        : params.defaultFilePointer)
      : `${params.provider}/apiKey`;
  const idRaw = await params.prompter.text({
    initialValue: idDefault,
    message: idPrompt,
    placeholder: providerEntry.source === "file" ? "/providers/openai/apiKey" : "openai/api-key",
    validate: (value) => {
      const candidate = value.trim();
      if (!candidate) {
        return "Secret id cannot be empty.";
      }
      if (
        providerEntry.source === "file" &&
        providerEntry.mode !== "singleValue" &&
        !isValidFileSecretRefId(candidate)
      ) {
        return 'Use an absolute JSON pointer like "/providers/openai/apiKey".';
      }
      if (
        providerEntry.source === "file" &&
        providerEntry.mode === "singleValue" &&
        candidate !== "value"
      ) {
        return 'singleValue mode expects id "value".';
      }
      if (providerEntry.source === "exec" && !isValidExecSecretRefId(candidate)) {
        return formatExecSecretRefIdValidationMessage();
      }
      return undefined;
    },
  });
  const id = normalizeStringifiedOptionalString(idRaw) || idDefault;
  const ref: SecretRef = {
    id,
    provider: selectedProvider,
    source: providerEntry.source,
  };

  try {
    const { resolveSecretRefString } = await loadSecretResolve();
    const resolvedValue = await resolveSecretRefString(ref, {
      config: params.config,
      env: params.env ?? process.env,
    });
    await params.prompter.note(
      params.copy?.providerValidatedMessage?.(selectedProvider, id, providerEntry.source) ??
        `Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`,
      "Reference validated",
    );
    return { ref, resolvedValue };
  } catch (error) {
    await params.prompter.note(
      [
        `Could not validate provider reference ${selectedProvider}:${id}.`,
        formatErrorMessage(error),
        "Check your provider configuration and try again.",
      ].join("\n"),
      "Reference check failed",
    );
    throw new Error("retry", { cause: error });
  }
}

export async function promptSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const defaultEnvVar =
    params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
  const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
  let sourceChoice: SecretRefChoice = "env"; // Pragma: allowlist secret

  while (true) {
    const sourceRaw: SecretRefChoice = await params.prompter.select<SecretRefChoice>({
      initialValue: sourceChoice,
      message: params.copy?.sourceMessage ?? "Where is this API key stored?",
      options: [
        {
          hint: "Reference a variable from your runtime environment",
          label: "Environment variable",
          value: "env",
        },
        {
          hint: "Use a configured file or exec secret provider",
          label: "Configured secret provider",
          value: "provider",
        },
      ],
    });
    const source: SecretRefChoice = sourceRaw === "provider" ? "provider" : "env";
    sourceChoice = source;

    if (source === "env") {
      return await promptEnvSecretRefForSetup({
        config: params.config,
        copy: params.copy,
        defaultEnvVar,
        env: params.env,
        prompter: params.prompter,
        provider: params.provider,
      });
    }

    try {
      return await promptProviderSecretRefForSetup({
        config: params.config,
        copy: params.copy,
        defaultFilePointer,
        env: params.env,
        prompter: params.prompter,
        provider: params.provider,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "retry") {
        continue;
      }
      throw error;
    }
  }
}
