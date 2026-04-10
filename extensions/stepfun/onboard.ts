import {
  type ModelProviderConfig,
  type OpenClawConfig,
  type ProviderOnboardPresetAppliers,
  createModelCatalogPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_PLAN_PROVIDER_ID,
  STEPFUN_PROVIDER_ID,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
  buildStepFunPlanProvider,
  buildStepFunProvider,
} from "./provider-catalog.js";

export {
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
};

function createStepFunPresetAppliers(params: {
  providerId: string;
  primaryModelRef: string;
  alias: string;
  buildProvider: (baseUrl: string) => ModelProviderConfig;
}): ProviderOnboardPresetAppliers<[string]> {
  return createModelCatalogPresetAppliers<[string]>({
    primaryModelRef: params.primaryModelRef,
    resolveParams: (_cfg: OpenClawConfig, baseUrl: string) => {
      const provider = params.buildProvider(baseUrl);
      const models = provider.models ?? [];
      return {
        aliases: [
          ...models.map((model) => `${params.providerId}/${model.id}`),
          { alias: params.alias, modelRef: params.primaryModelRef },
        ],
        api: provider.api ?? "openai-completions",
        baseUrl,
        catalogModels: models,
        providerId: params.providerId,
      };
    },
  });
}

const stepFunPresetAppliers = createStepFunPresetAppliers({
  alias: "StepFun",
  buildProvider: buildStepFunProvider,
  primaryModelRef: STEPFUN_DEFAULT_MODEL_REF,
  providerId: STEPFUN_PROVIDER_ID,
});

const stepFunPlanPresetAppliers = createStepFunPresetAppliers({
  alias: "StepFun Plan",
  buildProvider: buildStepFunPlanProvider,
  primaryModelRef: STEPFUN_PLAN_DEFAULT_MODEL_REF,
  providerId: STEPFUN_PLAN_PROVIDER_ID,
});

export function applyStepFunStandardConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_CN_BASE_URL);
}

export function applyStepFunStandardConfig(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_INTL_BASE_URL);
}

export function applyStepFunPlanConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_CN_BASE_URL);
}

export function applyStepFunPlanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_INTL_BASE_URL);
}
