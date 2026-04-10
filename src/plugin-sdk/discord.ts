// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/discord/contract-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "contract-api.js",
    dirName: "discord",
  });
}

export const collectDiscordSecurityAuditFindings: FacadeModule["collectDiscordSecurityAuditFindings"] =
  ((...args) =>
    loadFacadeModule().collectDiscordSecurityAuditFindings(
      ...args,
    )) as FacadeModule["collectDiscordSecurityAuditFindings"];
