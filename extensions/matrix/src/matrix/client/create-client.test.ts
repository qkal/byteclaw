import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ensureMatrixSdkLoggingConfiguredMock = vi.hoisted(() => vi.fn());
const resolveValidatedMatrixHomeserverUrlMock = vi.hoisted(() => vi.fn());
const maybeMigrateLegacyStorageMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveMatrixStoragePathsMock = vi.hoisted(() => vi.fn());
const writeStorageMetaMock = vi.hoisted(() => vi.fn());
const MatrixClientMock = vi.hoisted(() => vi.fn());

vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: ensureMatrixSdkLoggingConfiguredMock,
}));

vi.mock("./config.js", () => ({
  resolveValidatedMatrixHomeserverUrl: resolveValidatedMatrixHomeserverUrlMock,
}));

vi.mock("./storage.js", () => ({
  maybeMigrateLegacyStorage: maybeMigrateLegacyStorageMock,
  resolveMatrixStoragePaths: resolveMatrixStoragePathsMock,
  writeStorageMeta: writeStorageMetaMock,
}));

vi.mock("../sdk.js", () => ({
  MatrixClient: MatrixClientMock,
}));

let createMatrixClient: typeof import("./create-client.js").createMatrixClient;

describe("createMatrixClient", () => {
  const storagePaths = {
    accountKey: "default",
    idbSnapshotPath: "/tmp/openclaw-matrix-create-client-test/idb.snapshot",
    metaPath: "/tmp/openclaw-matrix-create-client-test/storage-meta.json",
    recoveryKeyPath: "/tmp/openclaw-matrix-create-client-test/recovery.key",
    rootDir: "/tmp/openclaw-matrix-create-client-test",
    storagePath: "/tmp/openclaw-matrix-create-client-test/storage.json",
    tokenHash: "token-hash",
  };

  beforeAll(async () => {
    ({ createMatrixClient } = await import("./create-client.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ensureMatrixSdkLoggingConfiguredMock.mockReturnValue(undefined);
    resolveValidatedMatrixHomeserverUrlMock.mockResolvedValue("https://matrix.example.org");
    resolveMatrixStoragePathsMock.mockReturnValue(storagePaths);
    MatrixClientMock.mockImplementation(function MockMatrixClient() {
      return {
        stop: vi.fn(),
      };
    });
  });

  it("persists storage metadata by default", async () => {
    await createMatrixClient({
      accessToken: "tok",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
    });

    expect(writeStorageMetaMock).toHaveBeenCalledWith({
      accountId: undefined,
      deviceId: undefined,
      homeserver: "https://matrix.example.org",
      storagePaths,
      userId: "@bot:example.org",
    });
    expect(resolveMatrixStoragePathsMock).toHaveBeenCalledTimes(1);
    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      autoBootstrapCrypto: undefined,
      cryptoDatabasePrefix: "openclaw-matrix-default-token-hash",
      deviceId: undefined,
      dispatcherPolicy: undefined,
      encryption: undefined,
      idbSnapshotPath: storagePaths.idbSnapshotPath,
      initialSyncLimit: undefined,
      localTimeoutMs: undefined,
      password: undefined,
      recoveryKeyPath: storagePaths.recoveryKeyPath,
      ssrfPolicy: undefined,
      storagePath: storagePaths.storagePath,
      userId: "@bot:example.org",
    });
  });

  it("skips persistent storage wiring when persistence is disabled", async () => {
    await createMatrixClient({
      accessToken: "tok",
      homeserver: "https://matrix.example.org",
      persistStorage: false,
      userId: "@bot:example.org",
    });

    expect(resolveMatrixStoragePathsMock).not.toHaveBeenCalled();
    expect(writeStorageMetaMock).not.toHaveBeenCalled();
    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      autoBootstrapCrypto: undefined,
      cryptoDatabasePrefix: undefined,
      deviceId: undefined,
      dispatcherPolicy: undefined,
      encryption: undefined,
      idbSnapshotPath: undefined,
      initialSyncLimit: undefined,
      localTimeoutMs: undefined,
      password: undefined,
      recoveryKeyPath: undefined,
      ssrfPolicy: undefined,
      storagePath: undefined,
      userId: "@bot:example.org",
    });
  });
});
