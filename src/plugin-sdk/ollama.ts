type FacadeModule = typeof import("@openclaw/ollama/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "api.js",
    dirName: "ollama",
  });
}

export const resolveOllamaApiBase: FacadeModule["resolveOllamaApiBase"] = ((...args) =>
  loadFacadeModule().resolveOllamaApiBase(...args)) as FacadeModule["resolveOllamaApiBase"];
