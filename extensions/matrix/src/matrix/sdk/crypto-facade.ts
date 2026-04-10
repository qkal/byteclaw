import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { EncryptedFile } from "./types.js";
import type {
  MatrixVerificationCryptoApi,
  MatrixVerificationManager,
  MatrixVerificationMethod,
  MatrixVerificationSummary,
} from "./verification-manager.js";

interface MatrixCryptoFacadeClient {
  getRoom: (roomId: string) => { hasEncryptionStateEvent: () => boolean } | null;
  getCrypto: () => unknown;
}

export interface MatrixCryptoFacade {
  prepare: (joinedRooms: string[]) => Promise<void>;
  updateSyncData: (
    toDeviceMessages: unknown,
    otkCounts: unknown,
    unusedFallbackKeyAlgs: unknown,
    changedDeviceLists: unknown,
    leftDeviceLists: unknown,
  ) => Promise<void>;
  isRoomEncrypted: (roomId: string) => Promise<boolean>;
  requestOwnUserVerification: () => Promise<MatrixVerificationSummary | null>;
  encryptMedia: (buffer: Buffer) => Promise<{ buffer: Buffer; file: Omit<EncryptedFile, "url"> }>;
  decryptMedia: (
    file: EncryptedFile,
    opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
  ) => Promise<Buffer>;
  getRecoveryKey: () => Promise<{
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null>;
  listVerifications: () => Promise<MatrixVerificationSummary[]>;
  ensureVerificationDmTracked: (params: {
    roomId: string;
    userId: string;
  }) => Promise<MatrixVerificationSummary | null>;
  requestVerification: (params: {
    ownUser?: boolean;
    userId?: string;
    deviceId?: string;
    roomId?: string;
  }) => Promise<MatrixVerificationSummary>;
  acceptVerification: (id: string) => Promise<MatrixVerificationSummary>;
  cancelVerification: (
    id: string,
    params?: { reason?: string; code?: string },
  ) => Promise<MatrixVerificationSummary>;
  startVerification: (
    id: string,
    method?: MatrixVerificationMethod,
  ) => Promise<MatrixVerificationSummary>;
  generateVerificationQr: (id: string) => Promise<{ qrDataBase64: string }>;
  scanVerificationQr: (id: string, qrDataBase64: string) => Promise<MatrixVerificationSummary>;
  confirmVerificationSas: (id: string) => Promise<MatrixVerificationSummary>;
  mismatchVerificationSas: (id: string) => Promise<MatrixVerificationSummary>;
  confirmVerificationReciprocateQr: (id: string) => Promise<MatrixVerificationSummary>;
  getVerificationSas: (
    id: string,
  ) => Promise<{ decimal?: [number, number, number]; emoji?: [string, string][] }>;
}

type MatrixCryptoNodeRuntime = typeof import("./crypto-node.runtime.js");
let matrixCryptoNodeRuntimePromise: Promise<MatrixCryptoNodeRuntime> | null = null;

async function loadMatrixCryptoNodeRuntime(): Promise<MatrixCryptoNodeRuntime> {
  // Keep the native crypto package out of the main CLI startup graph.
  matrixCryptoNodeRuntimePromise ??= import("./crypto-node.runtime.js");
  return await matrixCryptoNodeRuntimePromise;
}

export function createMatrixCryptoFacade(deps: {
  client: MatrixCryptoFacadeClient;
  verificationManager: MatrixVerificationManager;
  recoveryKeyStore: MatrixRecoveryKeyStore;
  getRoomStateEvent: (
    roomId: string,
    eventType: string,
    stateKey?: string,
  ) => Promise<Record<string, unknown>>;
  downloadContent: (
    mxcUrl: string,
    opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
  ) => Promise<Buffer>;
}): MatrixCryptoFacade {
  return {
    acceptVerification: async (id) => await deps.verificationManager.acceptVerification(id),
    cancelVerification: async (id, params) =>
      await deps.verificationManager.cancelVerification(id, params),
    confirmVerificationReciprocateQr: async (id) =>
      deps.verificationManager.confirmVerificationReciprocateQr(id),
    confirmVerificationSas: async (id) => await deps.verificationManager.confirmVerificationSas(id),
    decryptMedia: async (
      file: EncryptedFile,
      opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
    ): Promise<Buffer> => {
      const { Attachment, EncryptedAttachment } = await loadMatrixCryptoNodeRuntime();
      const encrypted = await deps.downloadContent(file.url, opts);
      const metadata: EncryptedFile = {
        hashes: file.hashes,
        iv: file.iv,
        key: file.key,
        url: file.url,
        v: file.v,
      };
      const attachment = new EncryptedAttachment(
        new Uint8Array(encrypted),
        JSON.stringify(metadata),
      );
      const decrypted = Attachment.decrypt(attachment);
      return Buffer.from(decrypted);
    },
    encryptMedia: async (
      buffer: Buffer,
    ): Promise<{ buffer: Buffer; file: Omit<EncryptedFile, "url"> }> => {
      const { Attachment } = await loadMatrixCryptoNodeRuntime();
      const encrypted = Attachment.encrypt(new Uint8Array(buffer));
      const mediaInfoJson = encrypted.mediaEncryptionInfo;
      if (!mediaInfoJson) {
        throw new Error("Matrix media encryption failed: missing media encryption info");
      }
      const parsed = JSON.parse(mediaInfoJson) as EncryptedFile;
      return {
        buffer: Buffer.from(encrypted.encryptedData),
        file: {
          hashes: parsed.hashes,
          iv: parsed.iv,
          key: parsed.key,
          v: parsed.v,
        },
      };
    },
    ensureVerificationDmTracked: async ({ roomId, userId }) => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      const request =
        typeof crypto?.findVerificationRequestDMInProgress === "function"
          ? crypto.findVerificationRequestDMInProgress(roomId, userId)
          : undefined;
      if (!request) {
        return null;
      }
      return deps.verificationManager.trackVerificationRequest(request);
    },
    generateVerificationQr: async (id) => await deps.verificationManager.generateVerificationQr(id),
    getRecoveryKey: async () => deps.recoveryKeyStore.getRecoveryKeySummary(),
    getVerificationSas: async (id) => deps.verificationManager.getVerificationSas(id),
    isRoomEncrypted: async (roomId: string): Promise<boolean> => {
      const room = deps.client.getRoom(roomId);
      if (room?.hasEncryptionStateEvent()) {
        return true;
      }
      try {
        const event = await deps.getRoomStateEvent(roomId, "m.room.encryption", "");
        return typeof event.algorithm === "string" && event.algorithm.length > 0;
      } catch {
        return false;
      }
    },
    listVerifications: async () => deps.verificationManager.listVerifications(),
    mismatchVerificationSas: async (id) => deps.verificationManager.mismatchVerificationSas(id),
    prepare: async (_joinedRooms: string[]) => {
      // Matrix-js-sdk performs crypto prep during startup; no extra work required here.
    },
    requestOwnUserVerification: async () => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      return await deps.verificationManager.requestOwnUserVerification(crypto);
    },
    requestVerification: async (params) => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      return await deps.verificationManager.requestVerification(crypto, params);
    },
    scanVerificationQr: async (id, qrDataBase64) =>
      await deps.verificationManager.scanVerificationQr(id, qrDataBase64),
    startVerification: async (id, method = "sas") =>
      await deps.verificationManager.startVerification(id, method),
    updateSyncData: async (
      _toDeviceMessages: unknown,
      _otkCounts: unknown,
      _unusedFallbackKeyAlgs: unknown,
      _changedDeviceLists: unknown,
      _leftDeviceLists: unknown,
    ) => {
      // Compatibility no-op
    },
  };
}
