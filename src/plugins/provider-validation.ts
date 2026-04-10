import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import type { PluginDiagnostic, ProviderAuthMethod, ProviderPlugin } from "./types.js";

type ProviderWizardSetup = NonNullable<NonNullable<ProviderPlugin["wizard"]>["setup"]>;
type ProviderWizardModelPicker = NonNullable<NonNullable<ProviderPlugin["wizard"]>["modelPicker"]>;
type ProviderWizardModelAllowlist = NonNullable<ProviderWizardSetup["modelAllowlist"]>;

function pushProviderDiagnostic(params: {
  level: PluginDiagnostic["level"];
  pluginId: string;
  source: string;
  message: string;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}) {
  params.pushDiagnostic({
    level: params.level,
    message: params.message,
    pluginId: params.pluginId,
    source: params.source,
  });
}

function normalizeTextList(values: string[] | undefined): string[] | undefined {
  const normalized = [...new Set(normalizeTrimmedStringList(values))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOnboardingScopes(
  values: ("text-inference" | "image-generation")[] | undefined,
): ("text-inference" | "image-generation")[] | undefined {
  const normalized = [
    ...new Set(
      (values ?? []).filter(
        (value): value is "text-inference" | "image-generation" =>
          value === "text-inference" || value === "image-generation",
      ),
    ),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderOAuthProfileIdRepairs(
  values: ProviderPlugin["oauthProfileIdRepairs"],
): ProviderPlugin["oauthProfileIdRepairs"] {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .map((value) => {
      const legacyProfileId = normalizeOptionalString(value?.legacyProfileId);
      const promptLabel = normalizeOptionalString(value?.promptLabel);
      if (!legacyProfileId && !promptLabel) {
        return null;
      }
      return {
        ...(legacyProfileId ? { legacyProfileId } : {}),
        ...(promptLabel ? { promptLabel } : {}),
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveWizardMethodId(params: {
  providerId: string;
  pluginId: string;
  source: string;
  auth: ProviderAuthMethod[];
  methodId: string | undefined;
  metadataKind: "setup" | "model-picker";
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): string | undefined {
  if (!params.methodId) {
    return undefined;
  }
  if (params.auth.some((method) => method.id === params.methodId)) {
    return params.methodId;
  }
  pushProviderDiagnostic({
    level: "warn",
    message: `provider "${params.providerId}" ${params.metadataKind} method "${params.methodId}" not found; falling back to available methods`,
    pluginId: params.pluginId,
    pushDiagnostic: params.pushDiagnostic,
    source: params.source,
  });
  return undefined;
}

function buildNormalizedModelAllowlist(
  modelAllowlist: ProviderWizardModelAllowlist | undefined,
): ProviderWizardModelAllowlist | undefined {
  if (!modelAllowlist) {
    return undefined;
  }
  const allowedKeys = normalizeTextList(modelAllowlist.allowedKeys);
  const initialSelections = normalizeTextList(modelAllowlist.initialSelections);
  const message = normalizeOptionalString(modelAllowlist.message);
  if (!allowedKeys && !initialSelections && !message) {
    return undefined;
  }
  return {
    ...(allowedKeys ? { allowedKeys } : {}),
    ...(initialSelections ? { initialSelections } : {}),
    ...(message ? { message } : {}),
  };
}

function buildNormalizedWizardSetup(params: {
  setup: ProviderWizardSetup;
  methodId: string | undefined;
}): ProviderWizardSetup {
  const choiceId = normalizeOptionalString(params.setup.choiceId);
  const choiceLabel = normalizeOptionalString(params.setup.choiceLabel);
  const choiceHint = normalizeOptionalString(params.setup.choiceHint);
  const groupId = normalizeOptionalString(params.setup.groupId);
  const groupLabel = normalizeOptionalString(params.setup.groupLabel);
  const groupHint = normalizeOptionalString(params.setup.groupHint);
  const onboardingScopes = normalizeOnboardingScopes(params.setup.onboardingScopes);
  const modelAllowlist = buildNormalizedModelAllowlist(params.setup.modelAllowlist);
  return {
    ...(choiceId ? { choiceId } : {}),
    ...(choiceLabel ? { choiceLabel } : {}),
    ...(choiceHint ? { choiceHint } : {}),
    ...(typeof params.setup.assistantPriority === "number" &&
    Number.isFinite(params.setup.assistantPriority)
      ? { assistantPriority: params.setup.assistantPriority }
      : {}),
    ...(params.setup.assistantVisibility === "manual-only" ||
    params.setup.assistantVisibility === "visible"
      ? { assistantVisibility: params.setup.assistantVisibility }
      : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupLabel ? { groupLabel } : {}),
    ...(groupHint ? { groupHint } : {}),
    ...(params.methodId ? { methodId: params.methodId } : {}),
    ...(onboardingScopes ? { onboardingScopes } : {}),
    ...(modelAllowlist ? { modelAllowlist } : {}),
  };
}

function buildNormalizedModelPicker(
  modelPicker: ProviderWizardModelPicker,
  methodId: string | undefined,
): ProviderWizardModelPicker {
  const label = normalizeOptionalString(modelPicker.label);
  const hint = normalizeOptionalString(modelPicker.hint);
  return {
    ...(label ? { label } : {}),
    ...(hint ? { hint } : {}),
    ...(methodId ? { methodId } : {}),
  };
}

function normalizeProviderWizardSetup(params: {
  providerId: string;
  pluginId: string;
  source: string;
  auth: ProviderAuthMethod[];
  setup: ProviderWizardSetup;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderWizardSetup | undefined {
  const hasAuthMethods = params.auth.length > 0;
  if (!params.setup) {
    return undefined;
  }
  if (!hasAuthMethods) {
    pushProviderDiagnostic({
      level: "warn",
      message: `provider "${params.providerId}" setup metadata ignored because it has no auth methods`,
      pluginId: params.pluginId,
      pushDiagnostic: params.pushDiagnostic,
      source: params.source,
    });
    return undefined;
  }
  const methodId = resolveWizardMethodId({
    auth: params.auth,
    metadataKind: "setup",
    methodId: normalizeOptionalString(params.setup.methodId),
    pluginId: params.pluginId,
    providerId: params.providerId,
    pushDiagnostic: params.pushDiagnostic,
    source: params.source,
  });
  return buildNormalizedWizardSetup({
    methodId,
    setup: params.setup,
  });
}

function normalizeProviderAuthMethods(params: {
  providerId: string;
  pluginId: string;
  source: string;
  auth: ProviderAuthMethod[];
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderAuthMethod[] {
  const seenMethodIds = new Set<string>();
  const normalized: ProviderAuthMethod[] = [];

  for (const method of params.auth) {
    const methodId = normalizeOptionalString(method.id);
    if (!methodId) {
      pushProviderDiagnostic({
        level: "error",
        message: `provider "${params.providerId}" auth method missing id`,
        pluginId: params.pluginId,
        pushDiagnostic: params.pushDiagnostic,
        source: params.source,
      });
      continue;
    }
    if (seenMethodIds.has(methodId)) {
      pushProviderDiagnostic({
        level: "error",
        message: `provider "${params.providerId}" auth method duplicated id "${methodId}"`,
        pluginId: params.pluginId,
        pushDiagnostic: params.pushDiagnostic,
        source: params.source,
      });
      continue;
    }
    seenMethodIds.add(methodId);
    const wizardSetup = method.wizard;
    const wizard = wizardSetup
      ? normalizeProviderWizardSetup({
          auth: [{ ...method, id: methodId }],
          pluginId: params.pluginId,
          providerId: params.providerId,
          pushDiagnostic: params.pushDiagnostic,
          setup: wizardSetup,
          source: params.source,
        })
      : undefined;
    normalized.push({
      ...method,
      id: methodId,
      label: normalizeOptionalString(method.label) ?? methodId,
      ...(normalizeOptionalString(method.hint)
        ? { hint: normalizeOptionalString(method.hint) }
        : {}),
      ...(wizard ? { wizard } : {}),
    });
  }

  return normalized;
}

function normalizeProviderWizard(params: {
  providerId: string;
  pluginId: string;
  source: string;
  auth: ProviderAuthMethod[];
  wizard: ProviderPlugin["wizard"];
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin["wizard"] {
  if (!params.wizard) {
    return undefined;
  }

  const hasAuthMethods = params.auth.length > 0;
  const normalizeSetup = () => {
    const setup = params.wizard?.setup;
    if (!setup) {
      return undefined;
    }
    return normalizeProviderWizardSetup({
      auth: params.auth,
      pluginId: params.pluginId,
      providerId: params.providerId,
      pushDiagnostic: params.pushDiagnostic,
      setup,
      source: params.source,
    });
  };

  const normalizeModelPicker = () => {
    const modelPicker = params.wizard?.modelPicker;
    if (!modelPicker) {
      return undefined;
    }
    if (!hasAuthMethods) {
      pushProviderDiagnostic({
        level: "warn",
        message: `provider "${params.providerId}" model-picker metadata ignored because it has no auth methods`,
        pluginId: params.pluginId,
        pushDiagnostic: params.pushDiagnostic,
        source: params.source,
      });
      return undefined;
    }
    return buildNormalizedModelPicker(
      modelPicker,
      resolveWizardMethodId({
        auth: params.auth,
        metadataKind: "model-picker",
        methodId: normalizeOptionalString(modelPicker.methodId),
        pluginId: params.pluginId,
        providerId: params.providerId,
        pushDiagnostic: params.pushDiagnostic,
        source: params.source,
      }),
    );
  };

  const setup = normalizeSetup();
  const modelPicker = normalizeModelPicker();
  if (!setup && !modelPicker) {
    return undefined;
  }
  return {
    ...(setup ? { setup } : {}),
    ...(modelPicker ? { modelPicker } : {}),
  };
}

export function normalizeRegisteredProvider(params: {
  pluginId: string;
  source: string;
  provider: ProviderPlugin;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin | null {
  const id = normalizeOptionalString(params.provider.id);
  if (!id) {
    pushProviderDiagnostic({
      level: "error",
      message: "provider registration missing id",
      pluginId: params.pluginId,
      pushDiagnostic: params.pushDiagnostic,
      source: params.source,
    });
    return null;
  }

  const auth = normalizeProviderAuthMethods({
    auth: params.provider.auth ?? [],
    pluginId: params.pluginId,
    providerId: id,
    pushDiagnostic: params.pushDiagnostic,
    source: params.source,
  });
  const docsPath = normalizeOptionalString(params.provider.docsPath);
  const aliases = normalizeTextList(params.provider.aliases);
  const deprecatedProfileIds = normalizeTextList(params.provider.deprecatedProfileIds);
  const oauthProfileIdRepairs = normalizeProviderOAuthProfileIdRepairs(
    params.provider.oauthProfileIdRepairs,
  );
  const envVars = normalizeTextList(params.provider.envVars);
  const wizard = normalizeProviderWizard({
    auth,
    pluginId: params.pluginId,
    providerId: id,
    pushDiagnostic: params.pushDiagnostic,
    source: params.source,
    wizard: params.provider.wizard,
  });
  const { catalog } = params.provider;
  const { discovery } = params.provider;
  if (catalog && discovery) {
    pushProviderDiagnostic({
      level: "warn",
      message: `provider "${id}" registered both catalog and discovery; using catalog`,
      pluginId: params.pluginId,
      pushDiagnostic: params.pushDiagnostic,
      source: params.source,
    });
  }
  const {
    wizard: _ignoredWizard,
    docsPath: _ignoredDocsPath,
    aliases: _ignoredAliases,
    envVars: _ignoredEnvVars,
    catalog: _ignoredCatalog,
    discovery: _ignoredDiscovery,
    ...restProvider
  } = params.provider;
  return {
    ...restProvider,
    id,
    label: normalizeOptionalString(params.provider.label) ?? id,
    ...(docsPath ? { docsPath } : {}),
    ...(aliases ? { aliases } : {}),
    ...(deprecatedProfileIds ? { deprecatedProfileIds } : {}),
    ...(oauthProfileIdRepairs ? { oauthProfileIdRepairs } : {}),
    ...(envVars ? { envVars } : {}),
    auth,
    ...(catalog ? { catalog } : {}),
    ...(!catalog && discovery ? { discovery } : {}),
    ...(wizard ? { wizard } : {}),
  };
}
