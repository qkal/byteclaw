import { normalizeProviderId } from '../agents/provider-id.js';
import type { OpenClawConfig } from '../config/config.js';
import type { ModelProviderConfig } from '../config/types.js';
import { loadBundledPluginPublicArtifactModuleSync } from './public-surface-loader.js';
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from './types.js';

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ['provider-policy-api.js'] as const;

export interface BundledProviderPolicySurface {
  normalizeConfig?: (
    ctx: ProviderNormalizeConfigContext,
  ) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (
    ctx: ProviderResolveConfigApiKeyContext,
  ) => string | null | undefined;
}

const bundledProviderPolicySurfaceCache = new Map<
  string,
  BundledProviderPolicySurface | null
>();

function hasProviderPolicyHook(
  mod: Record<string, unknown>,
): mod is Record<string, unknown> & BundledProviderPolicySurface {
  return (
    typeof mod.normalizeConfig === 'function' ||
    typeof mod.applyConfigDefaults === 'function' ||
    typeof mod.resolveConfigApiKey === 'function'
  );
}

function tryLoadBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = loadBundledPluginPublicArtifactModuleSync<
        Record<string, unknown>
      >({
        artifactBasename,
        dirName: pluginId,
      });
      if (hasProviderPolicyHook(mod)) {
        return mod;
      }
    } catch (error) {
      // Catch all errors related to missing modules/files to prevent breaking config loading
      // This includes: "Unable to resolve bundled plugin public surface",
      // "Cannot find module 'openclaw/plugin-sdk/...'", and other loading errors
      if (error instanceof Error) {
        const errorMessage = error.message;
        if (
          errorMessage.startsWith(
            'Unable to resolve bundled plugin public surface ',
          ) ||
          errorMessage.startsWith('Cannot find module ') ||
          errorMessage.includes('Cannot find module') ||
          errorMessage.includes('is not exported from')
        ) {
          continue;
        }
      }
      throw error;
    }
  }
  return null;
}

export function clearBundledProviderPolicySurfaceCache(): void {
  bundledProviderPolicySurfaceCache.clear();
}

export function resolveBundledProviderPolicySurface(
  providerId: string,
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  if (bundledProviderPolicySurfaceCache.has(normalizedProviderId)) {
    return bundledProviderPolicySurfaceCache.get(normalizedProviderId) ?? null;
  }

  const surface = tryLoadBundledProviderPolicySurface(normalizedProviderId);
  if (surface) {
    bundledProviderPolicySurfaceCache.set(normalizedProviderId, surface);
    return surface;
  }

  bundledProviderPolicySurfaceCache.set(normalizedProviderId, null);
  return null;
}
