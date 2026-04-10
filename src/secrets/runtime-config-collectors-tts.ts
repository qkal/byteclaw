import {
  type ResolverContext,
  type SecretDefaults,
  collectSecretInputAssignment,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

function collectProviderApiKeyAssignment(params: {
  providerId: string;
  providerConfig: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  collectSecretInputAssignment({
    active: params.active,
    apply: (value) => {
      params.providerConfig.apiKey = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    inactiveReason: params.inactiveReason,
    path: `${params.pathPrefix}.providers.${params.providerId}.apiKey`,
    value: params.providerConfig.apiKey,
  });
}

export function collectTtsApiKeyAssignments(params: {
  tts: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const {providers} = params.tts;
  if (isRecord(providers)) {
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      if (!isRecord(providerConfig)) {
        continue;
      }
      collectProviderApiKeyAssignment({
        active: params.active,
        context: params.context,
        defaults: params.defaults,
        inactiveReason: params.inactiveReason,
        pathPrefix: params.pathPrefix,
        providerConfig,
        providerId,
      });
    }
    return;
  }
}
