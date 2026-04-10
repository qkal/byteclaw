import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMatrixAccountStorageRoot } from "../../../runtime-api.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  claimCurrentTokenStorageState,
  maybeMigrateLegacyStorage,
  repairCurrentTokenStorageMetaDeviceId,
  resolveMatrixStateFilePath,
  resolveMatrixStoragePaths,
} from "./storage.js";

const createBackupArchiveMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({
    archivePath: "/tmp/matrix-migration-snapshot.tar.gz",
    archiveRoot: "2026-03-17-openclaw-backup",
    assets: [],
    createdAt: "2026-03-17T00:00:00.000Z",
    dryRun: false,
    includeWorkspace: false,
    onlyConfig: false,
    skipped: [],
    verified: false,
  })),
);

const maybeCreateMatrixMigrationSnapshotMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({
    archivePath: "/tmp/matrix-migration-snapshot.tar.gz",
    created: true,
    markerPath: "/tmp/matrix-migration-snapshot.json",
  })),
);

vi.mock("../../../../../src/infra/backup-create.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../../src/infra/backup-create.js")>(
    "../../../../../src/infra/backup-create.js",
  );
  return {
    ...actual,
    createBackupArchive: (params: unknown) => createBackupArchiveMock(params),
  };
});
vi.mock("./migration-snapshot.runtime.js", () => ({
  maybeCreateMatrixMigrationSnapshot: (params: unknown) =>
    maybeCreateMatrixMigrationSnapshotMock(params),
}));
describe("matrix client storage paths", () => {
  const tempDirs: string[] = [];
  const defaultStorageAuth = {
    accessToken: "secret-token",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
  };

  afterEach(() => {
    createBackupArchiveMock.mockReset();
    createBackupArchiveMock.mockImplementation(async (_params: unknown) => ({
      archivePath: "/tmp/matrix-migration-snapshot.tar.gz",
      archiveRoot: "2026-03-17-openclaw-backup",
      assets: [],
      createdAt: "2026-03-17T00:00:00.000Z",
      dryRun: false,
      includeWorkspace: false,
      onlyConfig: false,
      skipped: [],
      verified: false,
    }));
    maybeCreateMatrixMigrationSnapshotMock.mockReset().mockResolvedValue({
      archivePath: "/tmp/matrix-migration-snapshot.tar.gz",
      created: true,
      markerPath: "/tmp/matrix-migration-snapshot.json",
    });
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function setupStateDir(
    cfg: Record<string, unknown> = {
      channels: {
        matrix: {},
      },
    },
  ): string {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-storage-"));
    const stateDir = path.join(homeDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(homeDir);
    installMatrixTestRuntime({
      cfg,
      logging: {
        getChildLogger: () => ({
          error: () => {},
          info: () => {},
          warn: () => {},
        }),
      },
      stateDir,
    });
    return stateDir;
  }

  function createMigrationEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      HOME: path.dirname(stateDir),
      OPENCLAW_HOME: path.dirname(stateDir),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
  }

  function resolveDefaultStoragePaths(
    overrides: Partial<{
      homeserver: string;
      userId: string;
      accessToken: string;
      accountId: string;
      deviceId: string;
    }> = {},
  ) {
    return resolveMatrixStoragePaths({
      ...defaultStorageAuth,
      ...overrides,
      env: {},
    });
  }

  it("resolves state file paths inside the selected storage root", () => {
    setupStateDir();
    const filePath = resolveMatrixStateFilePath({
      auth: {
        ...defaultStorageAuth,
        accountId: "ops",
        deviceId: "DEVICE1",
      },
      env: {},
      filename: "thread-bindings.json",
    });

    expect(filePath).toBe(
      path.join(
        resolveDefaultStoragePaths({ accountId: "ops", deviceId: "DEVICE1" }).rootDir,
        "thread-bindings.json",
      ),
    );
  });

  function writeLegacyMatrixStorage(
    stateDir: string,
    params: {
      storageBody?: string;
      withCrypto?: boolean;
    } = {},
  ) {
    const legacyRoot = path.join(stateDir, "matrix");
    if (params.withCrypto ?? true) {
      fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });
    }
    if (params.storageBody !== undefined) {
      fs.writeFileSync(path.join(legacyRoot, "bot-storage.json"), params.storageBody);
    }
    return legacyRoot;
  }

  function writeJson(rootDir: string, filename: string, value: Record<string, unknown>) {
    fs.writeFileSync(path.join(rootDir, filename), JSON.stringify(value, null, 2));
  }

  function seedExistingStorageRoot(params: {
    accessToken: string;
    deviceId?: string;
    storageBody?: string;
    storageMeta?: Record<string, unknown>;
    startupVerificationDeviceId?: string;
  }) {
    const storagePaths = resolveDefaultStoragePaths({
      accessToken: params.accessToken,
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, params.storageBody ?? '{"legacy":true}');
    if (params.storageMeta) {
      writeJson(storagePaths.rootDir, "storage-meta.json", params.storageMeta);
    }
    if (params.startupVerificationDeviceId) {
      writeJson(storagePaths.rootDir, "startup-verification.json", {
        deviceId: params.startupVerificationDeviceId,
      });
    }
    return storagePaths;
  }

  function seedCanonicalStorageRoot(params: {
    stateDir: string;
    accessToken: string;
    storageMeta: Record<string, unknown>;
  }) {
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      accessToken: params.accessToken,
      homeserver: defaultStorageAuth.homeserver,
      stateDir: params.stateDir,
      userId: defaultStorageAuth.userId,
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    writeJson(canonicalPaths.rootDir, "storage-meta.json", params.storageMeta);
    return canonicalPaths;
  }

  function expectCanonicalRootForNewDevice(stateDir: string) {
    const newerCanonicalPaths = seedCanonicalStorageRoot({
      accessToken: "secret-token-new",
      stateDir,
      storageMeta: {
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
        accountId: "default",
        deviceId: "NEWDEVICE",
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
      },
    });

    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "NEWDEVICE",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
  }

  it("uses the simplified matrix runtime root for account-scoped storage", () => {
    const stateDir = setupStateDir();

    const storagePaths = resolveMatrixStoragePaths({
      accessToken: "secret-token",
      accountId: "ops",
      env: {},
      homeserver: "https://matrix.example.org",
      userId: "@Bot:example.org",
    });

    expect(storagePaths.rootDir).toBe(
      path.join(
        stateDir,
        "matrix",
        "accounts",
        "ops",
        "matrix.example.org__bot_example.org",
        storagePaths.tokenHash,
      ),
    );
    expect(storagePaths.storagePath).toBe(path.join(storagePaths.rootDir, "bot-storage.json"));
    expect(storagePaths.cryptoPath).toBe(path.join(storagePaths.rootDir, "crypto"));
    expect(storagePaths.metaPath).toBe(path.join(storagePaths.rootDir, "storage-meta.json"));
    expect(storagePaths.recoveryKeyPath).toBe(path.join(storagePaths.rootDir, "recovery-key.json"));
    expect(storagePaths.idbSnapshotPath).toBe(
      path.join(storagePaths.rootDir, "crypto-idb-snapshot.json"),
    );
  });

  it("falls back to migrating the older flat matrix storage layout", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveDefaultStoragePaths();
    const legacyRoot = writeLegacyMatrixStorage(stateDir, { storageBody: '{"legacy":true}' });
    const env = createMigrationEnv(stateDir);

    await maybeMigrateLegacyStorage({
      env,
      storagePaths,
    });

    expect(maybeCreateMatrixMigrationSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        trigger: "matrix-client-fallback",
      }),
    );
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(false);
    expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe('{"legacy":true}');
    expect(fs.existsSync(storagePaths.cryptoPath)).toBe(true);
  });

  it("continues migrating whichever legacy artifact is still missing", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveDefaultStoragePaths();
    const legacyRoot = writeLegacyMatrixStorage(stateDir);
    const env = createMigrationEnv(stateDir);
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, '{"new":true}');

    await maybeMigrateLegacyStorage({
      env,
      storagePaths,
    });

    expect(maybeCreateMatrixMigrationSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        trigger: "matrix-client-fallback",
      }),
    );
    expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe('{"new":true}');
    expect(fs.existsSync(path.join(legacyRoot, "crypto"))).toBe(false);
    expect(fs.existsSync(storagePaths.cryptoPath)).toBe(true);
  });

  it("refuses to migrate legacy storage when the snapshot step fails", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveDefaultStoragePaths();
    const legacyRoot = writeLegacyMatrixStorage(stateDir, { storageBody: '{"legacy":true}' });
    const env = createMigrationEnv(stateDir);
    maybeCreateMatrixMigrationSnapshotMock.mockRejectedValueOnce(new Error("snapshot failed"));

    await expect(
      maybeMigrateLegacyStorage({
        env,
        storagePaths,
      }),
    ).rejects.toThrow("snapshot failed");
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
    expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
  });

  it("rolls back moved legacy storage when the crypto move fails", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveDefaultStoragePaths();
    const legacyRoot = writeLegacyMatrixStorage(stateDir, { storageBody: '{"legacy":true}' });
    const env = createMigrationEnv(stateDir);
    const realRenameSync = fs.renameSync.bind(fs);
    const renameSync = vi.spyOn(fs, "renameSync");
    renameSync.mockImplementation((sourcePath, targetPath) => {
      if (String(targetPath) === storagePaths.cryptoPath) {
        throw new Error("disk full");
      }
      return realRenameSync(sourcePath, targetPath);
    });

    await expect(
      maybeMigrateLegacyStorage({
        env,
        storagePaths,
      }),
    ).rejects.toThrow("disk full");
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
    expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
    expect(fs.existsSync(path.join(legacyRoot, "crypto"))).toBe(true);
  });

  it("refuses fallback migration when multiple Matrix accounts need explicit selection", async () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
            work: {},
          },
        },
      },
    });
    const storagePaths = resolveDefaultStoragePaths({ accountId: "ops" });
    const legacyRoot = writeLegacyMatrixStorage(stateDir, { storageBody: '{"legacy":true}' });
    const env = createMigrationEnv(stateDir);

    await expect(
      maybeMigrateLegacyStorage({
        env,
        storagePaths,
      }),
    ).rejects.toThrow(/defaultAccount is not set/i);
    expect(createBackupArchiveMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
  });

  it("refuses fallback migration for a non-selected Matrix account", async () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accessToken: "default-token",
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.ops.example.org",
            },
          },
          defaultAccount: "ops",
          homeserver: "https://matrix.default.example.org",
        },
      },
    });
    const storagePaths = resolveMatrixStoragePaths({
      accessToken: "default-token",
      env: {},
      homeserver: "https://matrix.default.example.org",
      userId: "@default:example.org",
    });
    const legacyRoot = writeLegacyMatrixStorage(stateDir, { storageBody: '{"legacy":true}' });
    const env = createMigrationEnv(stateDir);

    await expect(
      maybeMigrateLegacyStorage({
        env,
        storagePaths,
      }),
    ).rejects.toThrow(/targets account "ops"/i);
    expect(createBackupArchiveMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
  });

  it("keeps the canonical current-token storage root when deviceId is still unknown", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      accessToken: "secret-token-new",
      homeserver: defaultStorageAuth.homeserver,
      stateDir,
      userId: defaultStorageAuth.userId,
    });

    expect(rotatedStoragePaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(canonicalPaths.tokenHash);
    expect(rotatedStoragePaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("reuses an existing token-hash storage root for the same device after the access token changes", () => {
    setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        accountId: "default",
        deviceId: "DEVICE123",
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
      },
    });

    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(rotatedStoragePaths.storagePath).toBe(oldStoragePaths.storagePath);
  });

  it("does not reuse a populated older token-hash root while deviceId is unknown", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const newerCanonicalPaths = seedCanonicalStorageRoot({
      accessToken: "secret-token-new",
      stateDir,
      storageMeta: {
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
      },
    });

    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
    expect(resolvedPaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("does not reuse a populated sibling storage root from a different device", () => {
    const stateDir = setupStateDir();
    seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "OLDDEVICE",
      startupVerificationDeviceId: "OLDDEVICE",
    });
    expectCanonicalRootForNewDevice(stateDir);
  });

  it("does not reuse a populated sibling storage root with ambiguous device metadata", () => {
    const stateDir = setupStateDir();
    seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });
    expectCanonicalRootForNewDevice(stateDir);
  });

  it("keeps the current-token storage root stable after deviceId backfill when startup claimed state there", () => {
    const stateDir = setupStateDir();
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      accessToken: "secret-token-new",
      homeserver: defaultStorageAuth.homeserver,
      stateDir,
      userId: defaultStorageAuth.userId,
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    writeJson(canonicalPaths.rootDir, "storage-meta.json", {
      accessTokenHash: canonicalPaths.tokenHash,
      accountId: "default",
      deviceId: null,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
    });
    writeJson(canonicalPaths.rootDir, "thread-bindings.json", {
      bindings: [
        {
          accountId: "default",
          boundAt: 1,
          conversationId: "$thread-new",
          lastActivityAt: 1,
          targetKind: "subagent",
          targetSessionKey: "agent:ops:subagent:new",
        },
      ],
      version: 1,
    });
    expect(
      claimCurrentTokenStorageState({
        rootDir: canonicalPaths.rootDir,
      }),
    ).toBe(true);
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        accountId: "default",
        deviceId: "DEVICE123",
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
      },
    });
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });
    writeJson(oldStoragePaths.rootDir, "startup-verification.json", {
      deviceId: "DEVICE123",
    });

    repairCurrentTokenStorageMetaDeviceId({
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
    });

    const repairedMeta = JSON.parse(
      fs.readFileSync(path.join(canonicalPaths.rootDir, "storage-meta.json"), "utf8"),
    ) as { deviceId?: string | null };

    expect(repairedMeta.deviceId).toBe("DEVICE123");
    const startupPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    expect(startupPaths.rootDir).toBe(canonicalPaths.rootDir);
    const restartedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(canonicalPaths.rootDir);
  });

  it("does not keep the current-token storage root sticky when only marker files exist after backfill", () => {
    const stateDir = setupStateDir();
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      accessToken: "secret-token-new",
      homeserver: defaultStorageAuth.homeserver,
      stateDir,
      userId: defaultStorageAuth.userId,
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    writeJson(canonicalPaths.rootDir, "storage-meta.json", {
      accessTokenHash: canonicalPaths.tokenHash,
      accountId: "default",
      deviceId: null,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
    });
    writeJson(canonicalPaths.rootDir, "startup-verification.json", {
      deviceId: "DEVICE123",
    });
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        accountId: "default",
        deviceId: "DEVICE123",
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
      },
    });
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });
    writeJson(oldStoragePaths.rootDir, "thread-bindings.json", {
      bindings: [
        {
          accountId: "default",
          boundAt: 1,
          conversationId: "$thread-old",
          lastActivityAt: 1,
          targetKind: "subagent",
          targetSessionKey: "agent:ops:subagent:old",
        },
      ],
      version: 1,
    });

    repairCurrentTokenStorageMetaDeviceId({
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
    });

    const restartedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(oldStoragePaths.rootDir);
  });
});
