import { resolveProviderRawConfig, selectConfiguredOrAutoProvider } from "./provider-selection.js";

interface AutoSelectableProvider {
  id: string;
  autoSelectOrder?: number;
}

export type ResolvedConfiguredProvider<TProvider, TConfig> =
  | {
      ok: true;
      configuredProviderId?: string;
      provider: TProvider;
      providerConfig: TConfig;
    }
  | {
      ok: false;
      code: "missing-configured-provider" | "no-registered-provider" | "provider-not-configured";
      configuredProviderId?: string;
      provider?: TProvider;
    };

export function resolveConfiguredCapabilityProvider<
  TConfig,
  TFullConfig,
  TProvider extends AutoSelectableProvider,
>(params: {
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  cfg: TFullConfig | undefined;
  cfgForResolve: TFullConfig;
  getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
  listProviders: () => Iterable<TProvider>;
  resolveProviderConfig: (params: {
    provider: TProvider;
    cfg: TFullConfig;
    rawConfig: Record<string, unknown>;
  }) => TConfig;
  isProviderConfigured: (params: {
    provider: TProvider;
    cfg: TFullConfig | undefined;
    providerConfig: TConfig;
  }) => boolean;
}): ResolvedConfiguredProvider<TProvider, TConfig> {
  const selection = selectConfiguredOrAutoProvider({
    configuredProviderId: params.configuredProviderId,
    getConfiguredProvider: params.getConfiguredProvider,
    listProviders: params.listProviders,
  });
  if (selection.missingConfiguredProvider) {
    return {
      code: "missing-configured-provider",
      configuredProviderId: selection.configuredProviderId,
      ok: false,
    };
  }

  const { provider } = selection;
  if (!provider) {
    return {
      code: "no-registered-provider",
      configuredProviderId: selection.configuredProviderId,
      ok: false,
    };
  }

  const rawProviderConfig = resolveProviderRawConfig({
    configuredProviderId: selection.configuredProviderId,
    providerConfigs: params.providerConfigs,
    providerId: provider.id,
  });
  const providerConfig = params.resolveProviderConfig({
    cfg: params.cfgForResolve,
    provider,
    rawConfig: rawProviderConfig,
  });

  if (!params.isProviderConfigured({ cfg: params.cfg, provider, providerConfig })) {
    return {
      code: "provider-not-configured",
      configuredProviderId: selection.configuredProviderId,
      ok: false,
      provider,
    };
  }

  return {
    configuredProviderId: selection.configuredProviderId,
    ok: true,
    provider,
    providerConfig,
  };
}
