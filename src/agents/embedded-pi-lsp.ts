import type { OpenClawConfig } from "../config/config.js";
import type { BundleLspServerConfig } from "../plugins/bundle-lsp.js";
import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";

export interface EmbeddedPiLspConfig {
  lspServers: Record<string, BundleLspServerConfig>;
  diagnostics: { pluginId: string; message: string }[];
}

export function loadEmbeddedPiLspConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EmbeddedPiLspConfig {
  const bundleLsp = loadEnabledBundleLspConfig({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  // User-configured LSP servers could override bundle defaults here in the future.
  return {
    diagnostics: bundleLsp.diagnostics,
    lspServers: { ...bundleLsp.config.lspServers },
  };
}
