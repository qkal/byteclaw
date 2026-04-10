// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/matrix/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "api.js",
    dirName: "matrix",
  });
}
export const setMatrixThreadBindingIdleTimeoutBySessionKey: FacadeModule["setMatrixThreadBindingIdleTimeoutBySessionKey"] =
  ((...args) =>
    loadFacadeModule()["setMatrixThreadBindingIdleTimeoutBySessionKey"](
      ...args,
    )) as FacadeModule["setMatrixThreadBindingIdleTimeoutBySessionKey"];
export const setMatrixThreadBindingMaxAgeBySessionKey: FacadeModule["setMatrixThreadBindingMaxAgeBySessionKey"] =
  ((...args) =>
    loadFacadeModule()["setMatrixThreadBindingMaxAgeBySessionKey"](
      ...args,
    )) as FacadeModule["setMatrixThreadBindingMaxAgeBySessionKey"];
