import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GEMINI_2_5_PRO_PREFIX = "gemini-2.5-pro";
const GEMINI_2_5_FLASH_LITE_PREFIX = "gemini-2.5-flash-lite";
const GEMINI_2_5_FLASH_PREFIX = "gemini-2.5-flash";
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_LITE_PREFIX = "gemini-3.1-flash-lite";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMMA_PREFIX = "gemma-";
const GEMINI_2_5_PRO_TEMPLATE_IDS = ["gemini-2.5-pro"] as const;
const GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS = ["gemini-2.5-flash-lite"] as const;
const GEMINI_2_5_FLASH_TEMPLATE_IDS = ["gemini-2.5-flash"] as const;
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite-preview"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;
// Gemma uses the Gemini flash template as a forward-compat approximation
// Until a dedicated Gemma template is registered in the catalog.
const GEMMA_TEMPLATE_IDS = GEMINI_3_1_FLASH_TEMPLATE_IDS;

interface GoogleForwardCompatFamily {
  googleTemplateIds: readonly string[];
  cliTemplateIds: readonly string[];
  preferExternalFirstForCli?: boolean;
}

interface GoogleTemplateSource {
  templateProviderId: string;
  templateIds: readonly string[];
}

function cloneGoogleTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateProviderId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  return cloneFirstTemplateModel({
    ctx: params.ctx,
    modelId: params.modelId,
    patch: {
      ...params.patch,
      provider: params.providerId,
    },
    providerId: params.templateProviderId,
    templateIds: params.templateIds,
  });
}

function isGoogleGeminiCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === GOOGLE_GEMINI_CLI_PROVIDER_ID;
}

function templateIdsForProvider(
  templateProviderId: string,
  family: GoogleForwardCompatFamily,
): readonly string[] {
  return isGoogleGeminiCliProvider(templateProviderId)
    ? family.cliTemplateIds
    : family.googleTemplateIds;
}

function buildGoogleTemplateSources(params: {
  providerId: string;
  templateProviderId?: string;
  family: GoogleForwardCompatFamily;
}): GoogleTemplateSource[] {
  const defaultTemplateProviderId = params.templateProviderId?.trim()
    ? params.templateProviderId
    : (isGoogleGeminiCliProvider(params.providerId)
      ? "google"
      : GOOGLE_GEMINI_CLI_PROVIDER_ID);
  const preferredExternalFirst =
    isGoogleGeminiCliProvider(params.providerId) &&
    params.family.preferExternalFirstForCli === true;
  const orderedTemplateProviderIds = preferredExternalFirst
    ? [defaultTemplateProviderId, params.providerId]
    : [params.providerId, defaultTemplateProviderId];

  const seen = new Set<string>();
  const sources: GoogleTemplateSource[] = [];
  for (const providerId of orderedTemplateProviderIds) {
    const trimmed = providerId?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    sources.push({
      templateIds: templateIdsForProvider(trimmed, params.family),
      templateProviderId: trimmed,
    });
  }
  return sources;
}

export function resolveGoogleGeminiForwardCompatModel(params: {
  providerId: string;
  templateProviderId?: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = params.ctx.modelId.trim();
  const lower = normalizeOptionalLowercaseString(trimmed) ?? "";

  let family: GoogleForwardCompatFamily;
  let patch: Partial<ProviderRuntimeModel> | undefined;
  if (lower.startsWith(GEMINI_2_5_PRO_PREFIX)) {
    family = {
      cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
      googleTemplateIds: GEMINI_2_5_PRO_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX)) {
    family = {
      cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      googleTemplateIds: GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_PREFIX)) {
    family = {
      cliTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
      googleTemplateIds: GEMINI_2_5_FLASH_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) {
    family = {
      cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
      googleTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
    };
    if (params.providerId === "google" || params.providerId === GOOGLE_GEMINI_CLI_PROVIDER_ID) {
      patch = { reasoning: true };
    }
  } else if (lower.startsWith(GEMINI_3_1_FLASH_LITE_PREFIX)) {
    family = {
      cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      googleTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
    };
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    family = {
      cliTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
      googleTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
    };
  } else if (lower.startsWith(GEMMA_PREFIX)) {
    family = {
      cliTemplateIds: GEMMA_TEMPLATE_IDS,
      googleTemplateIds: GEMMA_TEMPLATE_IDS,
    };
    if (lower.startsWith("gemma-4")) {
      patch = { reasoning: true };
    }
  } else {
    return undefined;
  }

  for (const source of buildGoogleTemplateSources({
    family,
    providerId: params.providerId,
    templateProviderId: params.templateProviderId,
  })) {
    const model = cloneGoogleTemplateModel({
      ctx: params.ctx,
      modelId: trimmed,
      patch,
      providerId: params.providerId,
      templateIds: source.templateIds,
      templateProviderId: source.templateProviderId,
    });
    if (model) {
      return model;
    }
  }

  return undefined;
}

export function isModernGoogleModel(modelId: string): boolean {
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  return (
    lower.startsWith("gemini-2.5") || lower.startsWith("gemini-3") || lower.startsWith(GEMMA_PREFIX)
  );
}
