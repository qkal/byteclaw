// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/anthropic/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "api.js",
    dirName: "anthropic",
  });
}
export const { CLAUDE_CLI_BACKEND_ID } = loadFacadeModule();
export const isClaudeCliProvider: FacadeModule["isClaudeCliProvider"] = ((...args) =>
  loadFacadeModule()["isClaudeCliProvider"](...args)) as FacadeModule["isClaudeCliProvider"];
