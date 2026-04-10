import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncMemoryWikiImportedSources } from "./source-sync.js";

const { syncBridgeMock, syncUnsafeLocalMock, refreshIndexesMock } = vi.hoisted(() => ({
  refreshIndexesMock: vi.fn(),
  syncBridgeMock: vi.fn(),
  syncUnsafeLocalMock: vi.fn(),
}));

vi.mock("./bridge.js", () => ({
  syncMemoryWikiBridgeSources: syncBridgeMock,
}));

vi.mock("./unsafe-local.js", () => ({
  syncMemoryWikiUnsafeLocalSources: syncUnsafeLocalMock,
}));

vi.mock("./compile.js", () => ({
  refreshMemoryWikiIndexesAfterImport: refreshIndexesMock,
}));

const bridgeResult = {
  artifactCount: 10,
  importedCount: 1,
  pagePaths: ["sources/alpha.md"],
  removedCount: 4,
  skippedCount: 3,
  updatedCount: 2,
  workspaces: 2,
};

describe("syncMemoryWikiImportedSources", () => {
  beforeEach(() => {
    syncBridgeMock.mockReset();
    syncUnsafeLocalMock.mockReset();
    refreshIndexesMock.mockReset();
    syncBridgeMock.mockResolvedValue(bridgeResult);
    syncUnsafeLocalMock.mockResolvedValue({
      ...bridgeResult,
      workspaces: 0,
    });
    refreshIndexesMock.mockResolvedValue({
      compile: { updatedFiles: ["index.md", "sources/index.md"] },
      reason: "import-changed",
      refreshed: true,
    });
  });

  it("routes bridge mode through bridge sync and merges refresh results", async () => {
    const config = { vaultMode: "bridge" } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["config"];
    const appConfig = { agents: { list: [{ default: true, id: "main" }] } } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["appConfig"];

    const result = await syncMemoryWikiImportedSources({ appConfig, config });

    expect(syncBridgeMock).toHaveBeenCalledWith({ appConfig, config });
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: bridgeResult,
    });
    expect(result).toEqual({
      ...bridgeResult,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
      indexesRefreshed: true,
    });
  });

  it("routes unsafe-local mode through unsafe-local sync", async () => {
    const unsafeLocalResult = {
      ...bridgeResult,
      importedCount: 2,
      pagePaths: ["sources/private.md"],
      workspaces: 0,
    };
    syncUnsafeLocalMock.mockResolvedValueOnce(unsafeLocalResult);
    refreshIndexesMock.mockResolvedValueOnce({
      reason: "auto-compile-disabled",
      refreshed: false,
    });
    const config = { vaultMode: "unsafe-local" } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["config"];

    const result = await syncMemoryWikiImportedSources({ config });

    expect(syncUnsafeLocalMock).toHaveBeenCalledWith(config);
    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: unsafeLocalResult,
    });
    expect(result).toEqual({
      ...unsafeLocalResult,
      indexRefreshReason: "auto-compile-disabled",
      indexUpdatedFiles: [],
      indexesRefreshed: false,
    });
  });

  it("returns a no-op sync result outside imported-source modes", async () => {
    const config = { vaultMode: "isolated" } as Parameters<
      typeof syncMemoryWikiImportedSources
    >[0]["config"];

    const result = await syncMemoryWikiImportedSources({ config });

    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: {
        artifactCount: 0,
        importedCount: 0,
        pagePaths: [],
        removedCount: 0,
        skippedCount: 0,
        updatedCount: 0,
        workspaces: 0,
      },
    });
    expect(result).toEqual({
      artifactCount: 0,
      importedCount: 0,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
      indexesRefreshed: true,
      pagePaths: [],
      removedCount: 0,
      skippedCount: 0,
      updatedCount: 0,
      workspaces: 0,
    });
  });
});
