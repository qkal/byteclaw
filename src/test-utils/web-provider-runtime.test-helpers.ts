import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";

interface CommonWebProviderTestParams {
  pluginId: string;
  id: string;
  credentialPath: string;
  autoDetectOrder?: number;
  requiresCredential?: boolean;
  getCredentialValue?: (config?: Record<string, unknown>) => unknown;
  getConfiguredCredentialValue?: (config?: OpenClawConfig) => unknown;
}

export type WebSearchTestProviderParams = CommonWebProviderTestParams & {
  createTool?: PluginWebSearchProviderEntry["createTool"];
};

export type WebFetchTestProviderParams = CommonWebProviderTestParams & {
  createTool?: PluginWebFetchProviderEntry["createTool"];
};

function createCommonProviderFields(params: CommonWebProviderTestParams) {
  return {
    autoDetectOrder: params.autoDetectOrder,
    credentialPath: params.credentialPath,
    envVars: [`${params.id.toUpperCase()}_API_KEY`],
    getConfiguredCredentialValue: params.getConfiguredCredentialValue,
    getCredentialValue: params.getCredentialValue ?? (() => undefined),
    hint: `${params.id} runtime provider`,
    id: params.id,
    label: params.id,
    placeholder: `${params.id}-...`,
    pluginId: params.pluginId,
    requiresCredential: params.requiresCredential,
    setCredentialValue: () => {},
    signupUrl: `https://example.com/${params.id}`,
  };
}

function createDefaultProviderTool(providerId: string) {
  return {
    description: providerId,
    execute: async (args: Record<string, unknown>) => ({ ...args, provider: providerId }),
    parameters: {},
  };
}

export function createWebSearchTestProvider(
  params: WebSearchTestProviderParams,
): PluginWebSearchProviderEntry {
  return {
    ...createCommonProviderFields(params),
    createTool: params.createTool ?? (() => createDefaultProviderTool(params.id)),
  };
}

export function createWebFetchTestProvider(
  params: WebFetchTestProviderParams,
): PluginWebFetchProviderEntry {
  return {
    ...createCommonProviderFields(params),
    createTool: params.createTool ?? (() => createDefaultProviderTool(params.id)),
  };
}
