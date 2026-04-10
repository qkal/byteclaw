import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputRef,
} from "../../../../src/config/types.secrets.js";

export function hasConfiguredMemorySecretInput(value: unknown): boolean {
  return hasConfiguredSecretInput(value);
}

export function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const { ref } = resolveSecretInputRef({ value: params.value });
  if (ref?.source === "env") {
    const envValue = normalizeSecretInputString(process.env[ref.id]);
    if (envValue) {
      return envValue;
    }
  }
  return normalizeResolvedSecretInputString({
    path: params.path,
    value: params.value,
  });
}
