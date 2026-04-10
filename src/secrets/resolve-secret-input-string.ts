import type { OpenClawConfig } from "../config/config.js";
import {
  type SecretRef,
  normalizeSecretInputString,
  resolveSecretInputRef,
} from "../config/types.secrets.js";
import { resolveSecretRefString } from "./resolve.js";

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

export async function resolveSecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  env: NodeJS.ProcessEnv;
  defaults?: SecretDefaults;
  normalize?: (value: unknown) => string | undefined;
  onResolveRefError?: (error: unknown, ref: SecretRef) => never;
}): Promise<string | undefined> {
  const normalize = params.normalize ?? normalizeSecretInputString;
  const { ref } = resolveSecretInputRef({
    defaults: params.defaults ?? params.config.secrets?.defaults,
    value: params.value,
  });
  if (!ref) {
    return normalize(params.value);
  }

  let resolved: string;
  try {
    resolved = await resolveSecretRefString(ref, {
      config: params.config,
      env: params.env,
    });
  } catch (error) {
    if (params.onResolveRefError) {
      return params.onResolveRefError(error, ref);
    }
    throw error;
  }
  return normalize(resolved);
}
