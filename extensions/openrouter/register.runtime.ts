import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  DEFAULT_CONTEXT_TOKENS,
  buildProviderReplayFamilyHooks,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildProviderStreamFamilyHooks,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  getOpenRouterModelCapabilities,
  isProxyReasoningUnsupported,
  loadOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream-family";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { OPENROUTER_DEFAULT_MODEL_REF, applyOpenrouterConfig } from "./onboard.js";
import { buildOpenrouterProvider } from "./provider-catalog.js";

export {
  applyOpenrouterConfig,
  buildOpenrouterProvider,
  buildProviderReplayFamilyHooks,
  buildProviderStreamFamilyHooks,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  createProviderApiKeyAuthMethod,
  DEFAULT_CONTEXT_TOKENS,
  getOpenRouterModelCapabilities,
  isProxyReasoningUnsupported,
  loadOpenRouterModelCapabilities,
  OPENROUTER_DEFAULT_MODEL_REF,
  openrouterMediaUnderstandingProvider,
};
