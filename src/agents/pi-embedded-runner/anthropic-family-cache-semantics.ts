import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";

type AnthropicCacheRetentionFamily =
  | "anthropic-direct"
  | "anthropic-bedrock"
  | "custom-anthropic-api";

export function isAnthropicModelRef(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).startsWith("anthropic/");
}

/** Matches Application Inference Profile ARNs across all AWS partitions with Bedrock. */
const BEDROCK_APP_INFERENCE_PROFILE_ARN_RE = /^arn:aws(-cn|-us-gov)?:bedrock:/;

export function isAnthropicBedrockModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);

  // Direct Anthropic Claude model IDs and regional inference profiles
  // E.g. "anthropic.claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6", "global.anthropic.claude-opus-4-6-v1"
  if (normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude")) {
    return true;
  }

  // Application Inference Profile ARN — detect Claude via profile ID segment.
  // E.g. "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile"
  //
  // Limitation: This is a name-heuristic only. Application inference profiles have
  // User-defined names, so a profile named "my-prod-assistant" routing to Claude would
  // Miss cache semantics, while "my-claude-compat-llama" on a non-Claude model would
  // Incorrectly get them. The Bedrock API does not expose the underlying model in the
  // Profile ID itself — resolving this would require a GetInferenceProfile call, which
  // Is too expensive for a per-request check. System-defined profiles (us., eu., global.)
  // Always contain "anthropic.claude" and are matched above.
  if (
    BEDROCK_APP_INFERENCE_PROFILE_ARN_RE.test(normalized) &&
    normalized.includes(":application-inference-profile/")
  ) {
    const profileId = normalized.split(":application-inference-profile/")[1] ?? "";
    return profileId.includes("claude");
  }

  return false;
}

export function isOpenRouterAnthropicModelRef(provider: string, modelId: string): boolean {
  return (
    normalizeOptionalLowercaseString(provider) === "openrouter" && isAnthropicModelRef(modelId)
  );
}

export function isAnthropicFamilyCacheTtlEligible(params: {
  provider: string;
  modelApi?: string;
  modelId: string;
}): boolean {
  const normalizedProvider = normalizeOptionalLowercaseString(params.provider);
  if (normalizedProvider === "anthropic" || normalizedProvider === "anthropic-vertex") {
    return true;
  }
  if (normalizedProvider === "amazon-bedrock") {
    return isAnthropicBedrockModel(params.modelId);
  }
  return params.modelApi === "anthropic-messages";
}

export function resolveAnthropicCacheRetentionFamily(params: {
  provider: string;
  modelApi?: string;
  modelId?: string;
  hasExplicitCacheConfig: boolean;
}): AnthropicCacheRetentionFamily | undefined {
  const normalizedProvider = normalizeOptionalLowercaseString(params.provider);
  if (normalizedProvider === "anthropic" || normalizedProvider === "anthropic-vertex") {
    return "anthropic-direct";
  }
  if (
    normalizedProvider === "amazon-bedrock" &&
    params.hasExplicitCacheConfig &&
    typeof params.modelId === "string" &&
    isAnthropicBedrockModel(params.modelId)
  ) {
    return "anthropic-bedrock";
  }
  if (
    normalizedProvider !== "amazon-bedrock" &&
    params.hasExplicitCacheConfig &&
    params.modelApi === "anthropic-messages"
  ) {
    return "custom-anthropic-api";
  }
  return undefined;
}
