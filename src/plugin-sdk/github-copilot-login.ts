// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/github-copilot/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "api.js",
    dirName: "github-copilot",
  });
}
export const githubCopilotLoginCommand: FacadeModule["githubCopilotLoginCommand"] = ((...args) =>
  loadFacadeModule()["githubCopilotLoginCommand"](
    ...args,
  )) as FacadeModule["githubCopilotLoginCommand"];
