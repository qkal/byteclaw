import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixCryptoBootstrapper, type MatrixCryptoBootstrapperDeps } from "./crypto-bootstrap.js";
import type { MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";

function createBootstrapperDeps() {
  return {
    decryptBridge: {
      bindCryptoRetrySignals: vi.fn(),
    },
    getDeviceId: vi.fn(() => "DEVICE123"),
    getPassword: vi.fn(() => "super-secret-password"),
    getUserId: vi.fn(async () => "@bot:example.org"),
    recoveryKeyStore: {
      bootstrapSecretStorageWithRecoveryKey: vi.fn(async () => {}),
    },
    verificationManager: {
      trackVerificationRequest: vi.fn(),
    },
  };
}

function createCryptoApi(overrides?: Partial<MatrixCryptoBootstrapApi>): MatrixCryptoBootstrapApi {
  return {
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: vi.fn(async () => {}),
    on: vi.fn(),
    requestOwnUserVerification: vi.fn(async () => null),
    ...overrides,
  };
}

function createVerifiedDeviceStatus(overrides?: {
  localVerified?: boolean;
  crossSigningVerified?: boolean;
  signedByOwner?: boolean;
}) {
  return {
    crossSigningVerified: overrides?.crossSigningVerified ?? true,
    isVerified: () => true,
    localVerified: overrides?.localVerified ?? true,
    signedByOwner: overrides?.signedByOwner ?? true,
  };
}

function createBootstrapperHarness(
  cryptoOverrides?: Partial<MatrixCryptoBootstrapApi>,
  depsOverrides?: Partial<ReturnType<typeof createBootstrapperDeps>>,
) {
  const deps = {
    ...createBootstrapperDeps(),
    ...depsOverrides,
  };
  const crypto = createCryptoApi(cryptoOverrides);
  const bootstrapper = new MatrixCryptoBootstrapper(
    deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
  );
  return { bootstrapper, crypto, deps };
}

async function runExplicitSecretStorageRepairScenario(firstError: string) {
  const bootstrapCrossSigning = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error(firstError))
    .mockResolvedValueOnce(undefined);
  const { deps, crypto, bootstrapper } = createBootstrapperHarness({
    bootstrapCrossSigning,
    getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    isCrossSigningReady: vi.fn(async () => true),
    userHasCrossSigningKeys: vi.fn(async () => true),
  });

  await bootstrapper.bootstrap(crypto, {
    allowAutomaticCrossSigningReset: false,
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    strict: true,
  });

  return { bootstrapCrossSigning, crypto, deps };
}

function expectSecretStorageRepairRetry(
  deps: ReturnType<typeof createBootstrapperDeps>,
  crypto: MatrixCryptoBootstrapApi,
  bootstrapCrossSigning: ReturnType<typeof vi.fn>,
) {
  expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(crypto, {
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    forceNewSecretStorage: true,
  });
  expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
}

async function bootstrapWithVerificationRequestListener(overrides?: {
  deps?: Partial<ReturnType<typeof createBootstrapperDeps>>;
  crypto?: Partial<MatrixCryptoBootstrapApi>;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const { deps, bootstrapper, crypto } = createBootstrapperHarness(
    {
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
        listeners.set(eventName, listener);
      }),
      ...overrides?.crypto,
    },
    overrides?.deps,
  );

  await bootstrapper.bootstrap(crypto);
  const listener = [...listeners.entries()].find(([eventName]) =>
    eventName.toLowerCase().includes("verificationrequest"),
  )?.[1];
  expect(listener).toBeTypeOf("function");

  return {
    deps,
    listener,
  };
}

describe("MatrixCryptoBootstrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstraps cross-signing/secret-storage and binds decrypt retry signals", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: false,
      },
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledTimes(2);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledWith(crypto);
  });

  it("forces new cross-signing keys only when readiness check still fails", async () => {
    const deps = createBootstrapperDeps();
    const bootstrapCrossSigning = vi.fn(async () => {});
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      isCrossSigningReady: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      userHasCrossSigningKeys: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
        setupNewCrossSigning: true,
      }),
    );
  });

  it("does not auto-reset cross-signing when automatic reset is disabled", async () => {
    const deps = createBootstrapperDeps();
    const bootstrapCrossSigning = vi.fn(async () => {});
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => ({
        crossSigningVerified: false,
        isVerified: () => true,
        localVerified: true,
        signedByOwner: true,
      })),
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1);
    expect(bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("passes explicit secret-storage repair allowance only when requested", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        crossSigningVerified: true,
        isVerified: () => true,
        localVerified: true,
        signedByOwner: true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto, {
      allowSecretStorageRecreateWithoutRecoveryKey: true,
      strict: true,
    });

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      },
    );
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits a stale server key", async () => {
    const { deps, crypto, bootstrapCrossSigning } = await runExplicitSecretStorageRepairScenario(
      "getSecretStorageKey callback returned falsey",
    );

    expectSecretStorageRepairRetry(deps, crypto, bootstrapCrossSigning);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits bad MAC", async () => {
    const { deps, crypto, bootstrapCrossSigning } = await runExplicitSecretStorageRepairScenario(
      "Error decrypting secret m.cross_signing.master: bad MAC",
    );

    expectSecretStorageRepairRetry(deps, crypto, bootstrapCrossSigning);
  });

  it("fails in strict mode when cross-signing keys are still unpublished", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      bootstrapCrossSigning: vi.fn(async () => {}),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await expect(bootstrapper.bootstrap(crypto, { strict: true })).rejects.toThrow(
      "Cross-signing bootstrap finished but server keys are still not published",
    );
  });

  it("uses password UIA fallback when null and dummy auth fail", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
    });

    await bootstrapper.bootstrap(crypto);

    const bootstrapCrossSigningCalls = bootstrapCrossSigning.mock.calls as [
      {
        authUploadDeviceSigningKeys?: <T>(
          makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
        ) => Promise<T>;
      }?,
    ][];
    const authUploadDeviceSigningKeys =
      bootstrapCrossSigningCalls[0]?.[0]?.authUploadDeviceSigningKeys;
    expect(authUploadDeviceSigningKeys).toBeTypeOf("function");

    const seenAuthStages: (Record<string, unknown> | null)[] = [];
    const result = await authUploadDeviceSigningKeys?.(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw new Error("need auth");
      }
      if (authData.type === "m.login.dummy") {
        throw new Error("dummy rejected");
      }
      if (authData.type === "m.login.password") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([
      null,
      { type: "m.login.dummy" },
      {
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "super-secret-password",
        type: "m.login.password", // Pragma: allowlist secret
      },
    ]);
  });

  it("resets cross-signing when first bootstrap attempt throws", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce(undefined);
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
    });

    await bootstrapper.bootstrap(crypto);

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
        setupNewCrossSigning: true,
      }),
    );
  });

  it("marks own device verified and cross-signs it when needed", async () => {
    const deps = createBootstrapperDeps();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const crypto = createCryptoApi({
      crossSignDevice,
      getDeviceVerificationStatus: vi.fn(async () => ({
        crossSigningVerified: false,
        isVerified: () => false,
        localVerified: false,
        signedByOwner: false,
      })),
      isCrossSigningReady: vi.fn(async () => true),
      setDeviceVerified,
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
  });

  it("does not treat local-only trust as sufficient for own-device bootstrap", async () => {
    const deps = createBootstrapperDeps();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const getDeviceVerificationStatus = vi
      .fn<
        () => Promise<{
          isVerified: () => boolean;
          localVerified: boolean;
          crossSigningVerified: boolean;
          signedByOwner: boolean;
        }>
      >()
      .mockResolvedValueOnce({
        crossSigningVerified: false,
        isVerified: () => true,
        localVerified: true,
        signedByOwner: false,
      })
      .mockResolvedValueOnce({
        crossSigningVerified: true,
        isVerified: () => true,
        localVerified: true,
        signedByOwner: true,
      });
    const crypto = createCryptoApi({
      crossSignDevice,
      getDeviceVerificationStatus,
      isCrossSigningReady: vi.fn(async () => true),
      setDeviceVerified,
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
    expect(getDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("tracks incoming verification requests from other users", async () => {
    const { deps, listener } = await bootstrapWithVerificationRequestListener();
    const verificationRequest = {
      accept: vi.fn(async () => {}),
      initiatedByMe: false,
      isSelfVerification: false,
      otherUserId: "@alice:example.org",
    };
    await listener?.(verificationRequest);

    expect(deps.verificationManager.trackVerificationRequest).toHaveBeenCalledWith(
      verificationRequest,
    );
    expect(verificationRequest.accept).not.toHaveBeenCalled();
  });

  it("does not touch request state when tracking summary throws", async () => {
    const { listener } = await bootstrapWithVerificationRequestListener({
      crypto: {
        getDeviceVerificationStatus: vi.fn(async () => ({
          isVerified: () => true,
        })),
      },
      deps: {
        verificationManager: {
          trackVerificationRequest: vi.fn(() => {
            throw new Error("summary failure");
          }),
        },
      },
    });

    const verificationRequest = {
      accept: vi.fn(async () => {}),
      initiatedByMe: false,
      isSelfVerification: false,
      otherUserId: "@alice:example.org",
    };
    await listener?.(verificationRequest);

    expect(verificationRequest.accept).not.toHaveBeenCalled();
  });

  it("registers verification listeners only once across repeated bootstrap calls", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);
    await bootstrapper.bootstrap(crypto);

    expect(crypto.on).toHaveBeenCalledTimes(1);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledTimes(1);
  });
});
