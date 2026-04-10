import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

interface BrowserNodeHostFacadeModule {
  runBrowserProxyCommand(paramsJSON?: string | null): Promise<string>;
}

function loadFacadeModule(): BrowserNodeHostFacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<BrowserNodeHostFacadeModule>({
    artifactBasename: "runtime-api.js",
    dirName: "browser",
  });
}

export async function runBrowserProxyCommand(paramsJSON?: string | null): Promise<string> {
  return await loadFacadeModule().runBrowserProxyCommand(paramsJSON);
}
