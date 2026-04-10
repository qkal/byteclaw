// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/litellm/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "api.js",
    dirName: "litellm",
  });
}
export const applyLitellmConfig: FacadeModule["applyLitellmConfig"] = ((...args) =>
  loadFacadeModule()["applyLitellmConfig"](...args)) as FacadeModule["applyLitellmConfig"];
export const applyLitellmProviderConfig: FacadeModule["applyLitellmProviderConfig"] = ((...args) =>
  loadFacadeModule()["applyLitellmProviderConfig"](
    ...args,
  )) as FacadeModule["applyLitellmProviderConfig"];
export const buildLitellmModelDefinition: FacadeModule["buildLitellmModelDefinition"] = ((
  ...args
) =>
  loadFacadeModule()["buildLitellmModelDefinition"](
    ...args,
  )) as FacadeModule["buildLitellmModelDefinition"];
export const {LITELLM_BASE_URL} = loadFacadeModule();
export const {LITELLM_DEFAULT_MODEL_ID} = loadFacadeModule();
export const {LITELLM_DEFAULT_MODEL_REF} = loadFacadeModule();
