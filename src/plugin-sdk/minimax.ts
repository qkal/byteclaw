// Manual facade. Keep loader boundary explicit.
interface FacadeModule {
  MINIMAX_DEFAULT_MODEL_ID: string;
  MINIMAX_DEFAULT_MODEL_REF: string;
  MINIMAX_TEXT_MODEL_REFS: readonly string[];
}
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "api.js",
    dirName: "minimax",
  });
}

export const {MINIMAX_DEFAULT_MODEL_ID} = loadFacadeModule();
export const {MINIMAX_DEFAULT_MODEL_REF} = loadFacadeModule();
export const MINIMAX_TEXT_MODEL_REFS: FacadeModule["MINIMAX_TEXT_MODEL_REFS"] =
  createLazyFacadeArrayValue(
    () => loadFacadeModule().MINIMAX_TEXT_MODEL_REFS as unknown as readonly unknown[],
  ) as FacadeModule["MINIMAX_TEXT_MODEL_REFS"];
