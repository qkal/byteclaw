import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import type { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { LogService } from "./logger.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { isRepairableSecretStorageAccessError } from "./recovery-key-store.js";
import type {
  MatrixAuthDict,
  MatrixCryptoBootstrapApi,
  MatrixRawEvent,
  MatrixUiAuthCallback,
} from "./types.js";
import type {
  MatrixVerificationManager,
  MatrixVerificationRequestLike,
} from "./verification-manager.js";
import { isMatrixDeviceOwnerVerified } from "./verification-status.js";

export interface MatrixCryptoBootstrapperDeps<TRawEvent extends MatrixRawEvent> {
  getUserId: () => Promise<string>;
  getPassword?: () => string | undefined;
  getDeviceId: () => string | null | undefined;
  verificationManager: MatrixVerificationManager;
  recoveryKeyStore: MatrixRecoveryKeyStore;
  decryptBridge: Pick<MatrixDecryptBridge<TRawEvent>, "bindCryptoRetrySignals">;
}

export interface MatrixCryptoBootstrapOptions {
  forceResetCrossSigning?: boolean;
  allowAutomaticCrossSigningReset?: boolean;
  allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
  strict?: boolean;
}

export interface MatrixCryptoBootstrapResult {
  crossSigningReady: boolean;
  crossSigningPublished: boolean;
  ownDeviceVerified: boolean | null;
}

export class MatrixCryptoBootstrapper<TRawEvent extends MatrixRawEvent> {
  private verificationHandlerRegistered = false;

  constructor(private readonly deps: MatrixCryptoBootstrapperDeps<TRawEvent>) {}

  async bootstrap(
    crypto: MatrixCryptoBootstrapApi,
    options: MatrixCryptoBootstrapOptions = {},
  ): Promise<MatrixCryptoBootstrapResult> {
    const strict = options.strict === true;
    // Register verification listeners before expensive bootstrap work so incoming requests
    // Are not missed during startup.
    this.registerVerificationRequestHandler(crypto);
    await this.bootstrapSecretStorage(crypto, {
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      strict,
    });
    const crossSigning = await this.bootstrapCrossSigning(crypto, {
      allowAutomaticCrossSigningReset: options.allowAutomaticCrossSigningReset !== false,
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      forceResetCrossSigning: options.forceResetCrossSigning === true,
      strict,
    });
    await this.bootstrapSecretStorage(crypto, {
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      strict,
    });
    const ownDeviceVerified = await this.ensureOwnDeviceTrust(crypto, strict);
    return {
      crossSigningPublished: crossSigning.published,
      crossSigningReady: crossSigning.ready,
      ownDeviceVerified,
    };
  }

  private createSigningKeysUiAuthCallback(params: {
    userId: string;
    password?: string;
  }): MatrixUiAuthCallback {
    return async <T>(makeRequest: (authData: MatrixAuthDict | null) => Promise<T>): Promise<T> => {
      try {
        return await makeRequest(null);
      } catch {
        // Some homeservers require an explicit dummy UIA stage even when no user interaction is needed.
        try {
          return await makeRequest({ type: "m.login.dummy" });
        } catch {
          if (!params.password?.trim()) {
            throw new Error(
              "Matrix cross-signing key upload requires UIA; provide matrix.password for m.login.password fallback",
            );
          }
          return await makeRequest({
            identifier: { type: "m.id.user", user: params.userId },
            password: params.password,
            type: "m.login.password",
          });
        }
      }
    };
  }

  private async bootstrapCrossSigning(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      forceResetCrossSigning: boolean;
      allowAutomaticCrossSigningReset: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey: boolean;
      strict: boolean;
    },
  ): Promise<{ ready: boolean; published: boolean }> {
    const userId = await this.deps.getUserId();
    const authUploadDeviceSigningKeys = this.createSigningKeysUiAuthCallback({
      password: this.deps.getPassword?.(),
      userId,
    });
    const hasPublishedCrossSigningKeys = async (): Promise<boolean> => {
      if (typeof crypto.userHasCrossSigningKeys !== "function") {
        return true;
      }
      try {
        return await crypto.userHasCrossSigningKeys(userId, true);
      } catch {
        return false;
      }
    };
    const isCrossSigningReady = async (): Promise<boolean> => {
      if (typeof crypto.isCrossSigningReady !== "function") {
        return true;
      }
      try {
        return await crypto.isCrossSigningReady();
      } catch {
        return false;
      }
    };

    const finalize = async (): Promise<{ ready: boolean; published: boolean }> => {
      const ready = await isCrossSigningReady();
      const published = await hasPublishedCrossSigningKeys();
      if (ready && published) {
        LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
        return { published, ready };
      }
      const message = "Cross-signing bootstrap finished but server keys are still not published";
      LogService.warn("MatrixClientLite", message);
      if (options.strict) {
        throw new Error(message);
      }
      return { published, ready };
    };

    if (options.forceResetCrossSigning) {
      try {
        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys,
          setupNewCrossSigning: true,
        });
      } catch (error) {
        LogService.warn("MatrixClientLite", "Forced cross-signing reset failed:", error);
        if (options.strict) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        return { published: false, ready: false };
      }
      return await finalize();
    }

    // First pass: preserve existing cross-signing identity and ensure public keys are uploaded.
    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys,
      });
    } catch (error) {
      const shouldRepairSecretStorage =
        options.allowSecretStorageRecreateWithoutRecoveryKey &&
        isRepairableSecretStorageAccessError(error);
      if (shouldRepairSecretStorage) {
        LogService.warn(
          "MatrixClientLite",
          "Cross-signing bootstrap could not unlock secret storage; recreating secret storage during explicit bootstrap and retrying.",
        );
        await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
          allowSecretStorageRecreateWithoutRecoveryKey: true,
          forceNewSecretStorage: true,
        });
        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys,
        });
      } else if (!options.allowAutomaticCrossSigningReset) {
        LogService.warn(
          "MatrixClientLite",
          "Initial cross-signing bootstrap failed and automatic reset is disabled:",
          error,
        );
        return { published: false, ready: false };
      } else {
        LogService.warn(
          "MatrixClientLite",
          "Initial cross-signing bootstrap failed, trying reset:",
          error,
        );
        try {
          await crypto.bootstrapCrossSigning({
            authUploadDeviceSigningKeys,
            setupNewCrossSigning: true,
          });
        } catch (error) {
          LogService.warn("MatrixClientLite", "Failed to bootstrap cross-signing:", error);
          if (options.strict) {
            throw error instanceof Error ? error : new Error(String(error));
          }
          return { published: false, ready: false };
        }
      }
    }

    const firstPassReady = await isCrossSigningReady();
    const firstPassPublished = await hasPublishedCrossSigningKeys();
    if (firstPassReady && firstPassPublished) {
      LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
      return { published: true, ready: true };
    }

    if (!options.allowAutomaticCrossSigningReset) {
      return { published: firstPassPublished, ready: firstPassReady };
    }

    // Fallback: recover from broken local/server state by creating a fresh identity.
    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys,
        setupNewCrossSigning: true,
      });
    } catch (error) {
      LogService.warn("MatrixClientLite", "Fallback cross-signing bootstrap failed:", error);
      if (options.strict) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return { published: false, ready: false };
    }

    return await finalize();
  }

  private async bootstrapSecretStorage(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      strict: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey: boolean;
    },
  ): Promise<void> {
    try {
      await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
        allowSecretStorageRecreateWithoutRecoveryKey:
          options.allowSecretStorageRecreateWithoutRecoveryKey,
      });
      LogService.info("MatrixClientLite", "Secret storage bootstrap complete");
    } catch (error) {
      LogService.warn("MatrixClientLite", "Failed to bootstrap secret storage:", error);
      if (options.strict) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  private registerVerificationRequestHandler(crypto: MatrixCryptoBootstrapApi): void {
    if (this.verificationHandlerRegistered) {
      return;
    }
    this.verificationHandlerRegistered = true;

    // Track incoming requests; verification lifecycle decisions live in the
    // Verification manager so acceptance/start/dedupe share one code path.
    // Remote-user verifications are only auto-accepted. The human-operated
    // Client must explicitly choose "Verify by emoji" so we do not race a
    // Second SAS start from the bot side and end up with mismatched keys.
    crypto.on(CryptoEvent.VerificationRequestReceived, async (request) => {
      const verificationRequest = request as MatrixVerificationRequestLike;
      try {
        this.deps.verificationManager.trackVerificationRequest(verificationRequest);
      } catch (error) {
        LogService.warn(
          "MatrixClientLite",
          `Failed to track verification request from ${verificationRequest.otherUserId}:`,
          error,
        );
      }
    });

    this.deps.decryptBridge.bindCryptoRetrySignals(crypto);
    LogService.info("MatrixClientLite", "Verification request handler registered");
  }

  private async ensureOwnDeviceTrust(
    crypto: MatrixCryptoBootstrapApi,
    strict = false,
  ): Promise<boolean | null> {
    const deviceId = this.deps.getDeviceId()?.trim();
    if (!deviceId) {
      return null;
    }
    const userId = await this.deps.getUserId();

    const deviceStatus =
      typeof crypto.getDeviceVerificationStatus === "function"
        ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null)
        : null;
    const alreadyVerified = isMatrixDeviceOwnerVerified(deviceStatus);

    if (alreadyVerified) {
      return true;
    }

    if (typeof crypto.setDeviceVerified === "function") {
      await crypto.setDeviceVerified(userId, deviceId, true);
    }

    if (typeof crypto.crossSignDevice === "function") {
      const crossSigningReady =
        typeof crypto.isCrossSigningReady === "function"
          ? await crypto.isCrossSigningReady()
          : true;
      if (crossSigningReady) {
        await crypto.crossSignDevice(deviceId);
      }
    }

    const refreshedStatus =
      typeof crypto.getDeviceVerificationStatus === "function"
        ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null)
        : null;
    const verified = isMatrixDeviceOwnerVerified(refreshedStatus);
    if (!verified && strict) {
      throw new Error(`Matrix own device ${deviceId} is not verified by its owner after bootstrap`);
    }
    return verified;
  }
}
