import type { OpenClawConfig } from "../config/config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";

export interface EmbeddedPiMcpConfig {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
}

export function loadEmbeddedPiMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EmbeddedPiMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);

  return {
    // OpenClaw config is the owner-managed layer, so it overrides bundle defaults.
    diagnostics: bundleMcp.diagnostics,
    mcpServers: {
      ...bundleMcp.config.mcpServers,
      ...configuredMcp,
    },
  };
}
