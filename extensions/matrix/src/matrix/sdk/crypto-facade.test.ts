import { describe, expect, it, vi } from "vitest";
import { createMatrixCryptoFacade } from "./crypto-facade.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixVerificationManager } from "./verification-manager.js";

type MatrixCryptoFacadeDeps = Parameters<typeof createMatrixCryptoFacade>[0];

function createVerificationManagerMock(
  overrides: Partial<MatrixVerificationManager> = {},
): MatrixVerificationManager {
  return {
    acceptVerification: vi.fn(),
    cancelVerification: vi.fn(),
    confirmVerificationReciprocateQr: vi.fn(),
    confirmVerificationSas: vi.fn(),
    ensureVerificationDmTracked: vi.fn(async () => null),
    generateVerificationQr: vi.fn(),
    getVerificationSas: vi.fn(),
    listVerifications: vi.fn(async () => []),
    mismatchVerificationSas: vi.fn(),
    requestOwnUserVerification: vi.fn(async () => null),
    requestVerification: vi.fn(),
    scanVerificationQr: vi.fn(),
    startVerification: vi.fn(),
    ...overrides,
  } as unknown as MatrixVerificationManager;
}

function createRecoveryKeyStoreMock(
  summary: ReturnType<MatrixRecoveryKeyStore["getRecoveryKeySummary"]> = null,
): MatrixRecoveryKeyStore {
  return {
    getRecoveryKeySummary: vi.fn(() => summary),
  } as unknown as MatrixRecoveryKeyStore;
}

function createFacadeHarness(params?: {
  client?: Partial<MatrixCryptoFacadeDeps["client"]>;
  verificationManager?: Partial<MatrixVerificationManager>;
  recoveryKeySummary?: ReturnType<MatrixRecoveryKeyStore["getRecoveryKeySummary"]>;
  getRoomStateEvent?: MatrixCryptoFacadeDeps["getRoomStateEvent"];
  downloadContent?: MatrixCryptoFacadeDeps["downloadContent"];
}) {
  const getRoomStateEvent: MatrixCryptoFacadeDeps["getRoomStateEvent"] =
    params?.getRoomStateEvent ?? (async () => ({}));
  const downloadContent: MatrixCryptoFacadeDeps["downloadContent"] =
    params?.downloadContent ?? (async () => Buffer.alloc(0));
  const facade = createMatrixCryptoFacade({
    client: {
      getCrypto: params?.client?.getCrypto ?? (() => undefined),
      getRoom: params?.client?.getRoom ?? (() => null),
    },
    downloadContent,
    getRoomStateEvent,
    recoveryKeyStore: createRecoveryKeyStoreMock(params?.recoveryKeySummary ?? null),
    verificationManager: createVerificationManagerMock(params?.verificationManager),
  });
  return { downloadContent, facade, getRoomStateEvent };
}

describe("createMatrixCryptoFacade", () => {
  it("detects encrypted rooms from cached room state", async () => {
    const { facade } = createFacadeHarness({
      client: {
        getRoom: () => ({
          hasEncryptionStateEvent: () => true,
        }),
      },
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).resolves.toBe(true);
  });

  it("falls back to server room state when room cache has no encryption event", async () => {
    const getRoomStateEvent = vi.fn(async () => ({
      algorithm: "m.megolm.v1.aes-sha2",
    }));
    const { facade } = createFacadeHarness({
      client: {
        getRoom: () => ({
          hasEncryptionStateEvent: () => false,
        }),
      },
      getRoomStateEvent,
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).resolves.toBe(true);
    expect(getRoomStateEvent).toHaveBeenCalledWith("!room:example.org", "m.room.encryption", "");
  });

  it("forwards verification requests and uses client crypto API", async () => {
    const crypto = { requestOwnUserVerification: vi.fn(async () => null) };
    const requestVerification = vi.fn(async () => ({
      canAccept: false,
      completed: false,
      createdAt: new Date().toISOString(),
      hasReciprocateQr: false,
      hasSas: false,
      id: "verification-1",
      initiatedByMe: true,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 2,
      phaseName: "ready",
      updatedAt: new Date().toISOString(),
    }));
    const { facade } = createFacadeHarness({
      client: {
        getCrypto: () => crypto,
        getRoom: () => null,
      },
      recoveryKeySummary: { keyId: "KEY" },
      verificationManager: {
        requestVerification,
      },
    });

    const result = await facade.requestVerification({
      deviceId: "DEVICE",
      userId: "@alice:example.org",
    });

    expect(requestVerification).toHaveBeenCalledWith(crypto, {
      deviceId: "DEVICE",
      userId: "@alice:example.org",
    });
    expect(result.id).toBe("verification-1");
    await expect(facade.getRecoveryKey()).resolves.toMatchObject({ keyId: "KEY" });
  });

  it("rehydrates in-progress DM verification requests from the raw crypto layer", async () => {
    const request = {
      accept: vi.fn(async () => {}),
      accepting: false,
      cancel: vi.fn(async () => {}),
      declining: false,
      generateQRCode: vi.fn(),
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      on: vi.fn(),
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      roomId: "!dm:example.org",
      scanQRCode: vi.fn(),
      startVerification: vi.fn(),
      transactionId: "txn-dm-in-progress",
      verifier: undefined,
    };
    const trackVerificationRequest = vi.fn(() => ({
      canAccept: false,
      completed: false,
      createdAt: new Date().toISOString(),
      hasReciprocateQr: false,
      hasSas: false,
      id: "verification-1",
      initiatedByMe: false,
      isSelfVerification: false,
      methods: ["m.sas.v1"],
      otherUserId: "@alice:example.org",
      pending: true,
      phase: 3,
      phaseName: "started",
      roomId: "!dm:example.org",
      transactionId: "txn-dm-in-progress",
      updatedAt: new Date().toISOString(),
    }));
    const crypto = {
      findVerificationRequestDMInProgress: vi.fn(() => request),
      requestOwnUserVerification: vi.fn(async () => null),
    };
    const { facade } = createFacadeHarness({
      client: {
        getCrypto: () => crypto,
        getRoom: () => null,
      },
      verificationManager: {
        trackVerificationRequest,
      },
    });

    const summary = await facade.ensureVerificationDmTracked({
      roomId: "!dm:example.org",
      userId: "@alice:example.org",
    });

    expect(crypto.findVerificationRequestDMInProgress).toHaveBeenCalledWith(
      "!dm:example.org",
      "@alice:example.org",
    );
    expect(trackVerificationRequest).toHaveBeenCalledWith(request);
    expect(summary?.transactionId).toBe("txn-dm-in-progress");
  });
});
