// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/qa-lab/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "api.js",
    dirName: "qa-lab",
  });
}

export const registerQaLabCli: FacadeModule["registerQaLabCli"] = ((...args) =>
  loadFacadeModule().registerQaLabCli(...args)) as FacadeModule["registerQaLabCli"];
