import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../../../test/helpers/temp-home.js";
import { resolveMatrixAccountStorageRoot } from "../../../runtime-api.js";
import type { MatrixRoomKeyBackupRestoreResult } from "../sdk.js";
import { maybeRestoreLegacyMatrixBackup } from "./legacy-crypto-restore.js";

function createBackupStatus() {
  return {
    activeVersion: "1",
    decryptionKeyCached: true,
    keyLoadAttempted: true,
    keyLoadError: null,
    matchesDecryptionKey: true,
    serverVersion: "1",
    trusted: true,
  };
}

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

const BASE_AUTH = {
  accessToken: "tok-123",
  accountId: "default",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
};

type MatrixAuth = typeof BASE_AUTH;

function readLegacyMigrationState(rootDir: string) {
  const statePath = path.join(rootDir, "legacy-crypto-migration.json");
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
}

async function runLegacyRestoreScenario(params: {
  migration: Record<string, unknown>;
  auth?: MatrixAuth;
  sourceAuth?: MatrixAuth;
  restoreRoomKeyBackup: () => Promise<MatrixRoomKeyBackupRestoreResult>;
}) {
  return withTempHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const auth = params.auth ?? BASE_AUTH;
    const sourceAuth = params.sourceAuth ?? auth;
    const { rootDir } = resolveMatrixAccountStorageRoot({
      stateDir,
      ...auth,
    });
    const { rootDir: sourceRootDir } = resolveMatrixAccountStorageRoot({
      stateDir,
      ...sourceAuth,
    });

    writeFile(
      path.join(sourceRootDir, "legacy-crypto-migration.json"),
      JSON.stringify(params.migration),
    );

    const restoreRoomKeyBackup = vi.fn(params.restoreRoomKeyBackup);
    const result = await maybeRestoreLegacyMatrixBackup({
      auth,
      client: { restoreRoomKeyBackup },
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
      },
      stateDir,
    });

    return {
      restoreRoomKeyBackup,
      result,
      rootState: readLegacyMigrationState(rootDir),
      rootStateExists: fs.existsSync(path.join(rootDir, "legacy-crypto-migration.json")),
      sourceRootState: readLegacyMigrationState(sourceRootDir),
      sourceRootStateExists: fs.existsSync(
        path.join(sourceRootDir, "legacy-crypto-migration.json"),
      ),
    };
  });
}

describe("maybeRestoreLegacyMatrixBackup", () => {
  it("marks pending legacy backup restore as completed after success", async () => {
    const { result, sourceRootState } = await runLegacyRestoreScenario({
      migration: {
        accountId: "default",
        restoreStatus: "pending",
        roomKeyCounts: { backedUp: 8, total: 10 },
        version: 1,
      },
      restoreRoomKeyBackup: async () => ({
        backup: createBackupStatus(),
        backupVersion: "1",
        imported: 8,
        loadedFromSecretStorage: true,
        restoredAt: "2026-03-08T10:00:00.000Z",
        success: true,
        total: 8,
      }),
    });

    expect(result).toEqual({
      imported: 8,
      kind: "restored",
      localOnlyKeys: 2,
      total: 8,
    });
    const state = sourceRootState as {
      restoreStatus: string;
      importedCount: number;
      totalCount: number;
    };
    expect(state.restoreStatus).toBe("completed");
    expect(state.importedCount).toBe(8);
    expect(state.totalCount).toBe(8);
  });

  it("keeps the restore pending when startup restore fails", async () => {
    const { result, sourceRootState } = await runLegacyRestoreScenario({
      migration: {
        accountId: "default",
        restoreStatus: "pending",
        roomKeyCounts: { backedUp: 5, total: 5 },
        version: 1,
      },
      restoreRoomKeyBackup: async () => ({
        backup: createBackupStatus(),
        backupVersion: null,
        error: "backup unavailable",
        imported: 0,
        loadedFromSecretStorage: false,
        success: false,
        total: 0,
      }),
    });

    expect(result).toEqual({
      error: "backup unavailable",
      kind: "failed",
      localOnlyKeys: 0,
    });
    const state = sourceRootState as {
      restoreStatus: string;
      lastError: string;
    };
    expect(state.restoreStatus).toBe("pending");
    expect(state.lastError).toBe("backup unavailable");
  });

  it("restores from a sibling token-hash directory when the access token changed", async () => {
    const oldAuth = {
      ...BASE_AUTH,
      accessToken: "tok-old",
    };
    const newAuth = {
      ...oldAuth,
      accessToken: "tok-new",
    };
    const {
      result,
      rootStateExists: newRootStateExists,
      sourceRootState,
    } = await runLegacyRestoreScenario({
      auth: newAuth,
      migration: {
        accountId: "default",
        restoreStatus: "pending",
        roomKeyCounts: { backedUp: 3, total: 3 },
        version: 1,
      },
      restoreRoomKeyBackup: async () => ({
        backup: createBackupStatus(),
        backupVersion: "1",
        imported: 3,
        loadedFromSecretStorage: true,
        restoredAt: "2026-03-08T10:00:00.000Z",
        success: true,
        total: 3,
      }),
      sourceAuth: oldAuth,
    });

    expect(result).toEqual({
      imported: 3,
      kind: "restored",
      localOnlyKeys: 0,
      total: 3,
    });
    const oldState = sourceRootState as {
      restoreStatus: string;
    };
    expect(oldState.restoreStatus).toBe("completed");
    expect(newRootStateExists).toBe(false);
  });
});
