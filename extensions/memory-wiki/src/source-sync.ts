import type { OpenClawConfig } from "../api.js";
import { type BridgeMemoryWikiResult, syncMemoryWikiBridgeSources } from "./bridge.js";
import {
  type RefreshMemoryWikiIndexesResult,
  refreshMemoryWikiIndexesAfterImport,
} from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

export type MemoryWikiImportedSourceSyncResult = BridgeMemoryWikiResult & {
  indexesRefreshed: boolean;
  indexUpdatedFiles: string[];
  indexRefreshReason: RefreshMemoryWikiIndexesResult["reason"];
};

export async function syncMemoryWikiImportedSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}): Promise<MemoryWikiImportedSourceSyncResult> {
  let syncResult: BridgeMemoryWikiResult;
  if (params.config.vaultMode === "bridge") {
    syncResult = await syncMemoryWikiBridgeSources(params);
  } else if (params.config.vaultMode === "unsafe-local") {
    syncResult = await syncMemoryWikiUnsafeLocalSources(params.config);
  } else {
    syncResult = {
      artifactCount: 0,
      importedCount: 0,
      pagePaths: [],
      removedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      workspaces: 0,
    };
  }
  const refreshResult = await refreshMemoryWikiIndexesAfterImport({
    config: params.config,
    syncResult,
  });
  return {
    ...syncResult,
    indexRefreshReason: refreshResult.reason,
    indexUpdatedFiles: refreshResult.compile?.updatedFiles ?? [],
    indexesRefreshed: refreshResult.refreshed,
  };
}
