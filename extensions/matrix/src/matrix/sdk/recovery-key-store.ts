import fs from "node:fs";
import path from "node:path";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { formatMatrixErrorMessage, formatMatrixErrorReason } from "../errors.js";
import { LogService } from "./logger.js";
import type {
  MatrixCryptoBootstrapApi,
  MatrixCryptoCallbacks,
  MatrixGeneratedSecretStorageKey,
  MatrixSecretStorageStatus,
  MatrixStoredRecoveryKey,
} from "./types.js";

export function isRepairableSecretStorageAccessError(err: unknown): boolean {
  const message = formatMatrixErrorReason(err);
  if (!message) {
    return false;
  }
  if (message.includes("getsecretstoragekey callback returned falsey")) {
    return true;
  }
  // The homeserver still has secret storage, but the local recovery key cannot
  // Authenticate/decrypt a required secret. During explicit bootstrap we can
  // Recreate secret storage and continue with a new local baseline.
  if (message.includes("decrypting secret") && message.includes("bad mac")) {
    return true;
  }
  return false;
}

export class MatrixRecoveryKeyStore {
  private readonly secretStorageKeyCache = new Map<
    string,
    { key: Uint8Array; keyInfo?: MatrixStoredRecoveryKey["keyInfo"] }
  >();
  private stagedRecoveryKey: MatrixStoredRecoveryKey | null = null;
  private readonly stagedCacheKeyIds = new Set<string>();

  constructor(private readonly recoveryKeyPath?: string) {}

  buildCryptoCallbacks(): MatrixCryptoCallbacks {
    return {
      cacheSecretStorageKey: (keyId, keyInfo, key) => {
        const privateKey = new Uint8Array(key);
        const normalizedKeyInfo: MatrixStoredRecoveryKey["keyInfo"] = {
          name: typeof keyInfo?.name === "string" ? keyInfo.name : undefined,
          passphrase: keyInfo?.passphrase,
        };
        this.rememberSecretStorageKey(keyId, privateKey, normalizedKeyInfo);

        const stored = this.loadStoredRecoveryKey();
        this.saveRecoveryKeyToDisk({
          encodedPrivateKey: stored?.encodedPrivateKey,
          keyId,
          keyInfo: normalizedKeyInfo,
          privateKey,
        });
      },
      getSecretStorageKey: async ({ keys }) => {
        const requestedKeyIds = Object.keys(keys ?? {});
        if (requestedKeyIds.length === 0) {
          return null;
        }

        for (const keyId of requestedKeyIds) {
          const cached = this.secretStorageKeyCache.get(keyId);
          if (cached) {
            return [keyId, new Uint8Array(cached.key)];
          }
        }

        const staged = this.stagedRecoveryKey;
        if (staged?.privateKeyBase64) {
          const privateKey = new Uint8Array(Buffer.from(staged.privateKeyBase64, "base64"));
          if (privateKey.length > 0) {
            const stagedKeyId =
              staged.keyId && requestedKeyIds.includes(staged.keyId)
                ? staged.keyId
                : requestedKeyIds[0];
            if (stagedKeyId) {
              this.rememberSecretStorageKey(stagedKeyId, privateKey, staged.keyInfo);
              this.stagedCacheKeyIds.add(stagedKeyId);
              return [stagedKeyId, privateKey];
            }
          }
        }

        const stored = this.loadStoredRecoveryKey();
        if (!stored?.privateKeyBase64) {
          return null;
        }
        const privateKey = new Uint8Array(Buffer.from(stored.privateKeyBase64, "base64"));
        if (privateKey.length === 0) {
          return null;
        }

        if (stored.keyId && requestedKeyIds.includes(stored.keyId)) {
          this.rememberSecretStorageKey(stored.keyId, privateKey, stored.keyInfo);
          return [stored.keyId, privateKey];
        }

        const firstRequestedKeyId = requestedKeyIds[0];
        if (!firstRequestedKeyId) {
          return null;
        }
        this.rememberSecretStorageKey(firstRequestedKeyId, privateKey, stored.keyInfo);
        return [firstRequestedKeyId, privateKey];
      },
    };
  }

  getRecoveryKeySummary(): {
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null {
    const stored = this.loadStoredRecoveryKey();
    if (!stored) {
      return null;
    }
    return {
      createdAt: stored.createdAt,
      encodedPrivateKey: stored.encodedPrivateKey,
      keyId: stored.keyId,
    };
  }

  private resolveEncodedRecoveryKeyInput(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): {
    encodedPrivateKey: string;
    privateKey: Uint8Array;
    keyId: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  } {
    const encodedPrivateKey = params.encodedPrivateKey.trim();
    if (!encodedPrivateKey) {
      throw new Error("Matrix recovery key is required");
    }
    let privateKey: Uint8Array;
    try {
      privateKey = decodeRecoveryKey(encodedPrivateKey);
    } catch (error) {
      throw new Error(`Invalid Matrix recovery key: ${formatMatrixErrorMessage(error)}`, {
        cause: error,
      });
    }
    const keyId =
      typeof params.keyId === "string" && params.keyId.trim() ? params.keyId.trim() : null;
    return {
      encodedPrivateKey,
      keyId,
      keyInfo: params.keyInfo ?? this.loadStoredRecoveryKey()?.keyInfo,
      privateKey,
    };
  }

  storeEncodedRecoveryKey(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): {
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } {
    const prepared = this.resolveEncodedRecoveryKeyInput(params);
    this.saveRecoveryKeyToDisk({
      encodedPrivateKey: prepared.encodedPrivateKey,
      keyId: prepared.keyId,
      keyInfo: prepared.keyInfo,
      privateKey: prepared.privateKey,
    });
    if (prepared.keyId) {
      this.rememberSecretStorageKey(prepared.keyId, prepared.privateKey, prepared.keyInfo);
    }
    return this.getRecoveryKeySummary() ?? {};
  }

  stageEncodedRecoveryKey(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): void {
    const prepared = this.resolveEncodedRecoveryKeyInput(params);
    this.discardStagedRecoveryKey();
    this.stagedRecoveryKey = {
      createdAt: new Date().toISOString(),
      encodedPrivateKey: prepared.encodedPrivateKey,
      keyId: prepared.keyId,
      keyInfo: prepared.keyInfo,
      privateKeyBase64: Buffer.from(prepared.privateKey).toString("base64"),
      version: 1,
    };
  }

  commitStagedRecoveryKey(params?: {
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): {
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null {
    if (!this.stagedRecoveryKey) {
      return this.getRecoveryKeySummary();
    }
    const staged = this.stagedRecoveryKey;
    const privateKey = new Uint8Array(Buffer.from(staged.privateKeyBase64, "base64"));
    const keyId =
      typeof params?.keyId === "string" && params.keyId.trim() ? params.keyId.trim() : staged.keyId;
    this.saveRecoveryKeyToDisk({
      encodedPrivateKey: staged.encodedPrivateKey,
      keyId,
      keyInfo: params?.keyInfo ?? staged.keyInfo,
      privateKey,
    });
    this.clearStagedRecoveryKeyTracking();
    return this.getRecoveryKeySummary();
  }

  discardStagedRecoveryKey(): void {
    for (const keyId of this.stagedCacheKeyIds) {
      this.secretStorageKeyCache.delete(keyId);
    }
    this.clearStagedRecoveryKeyTracking();
  }

  async bootstrapSecretStorageWithRecoveryKey(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      setupNewKeyBackup?: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
      forceNewSecretStorage?: boolean;
    } = {},
  ): Promise<void> {
    let status: MatrixSecretStorageStatus | null = null;
    const {getSecretStorageStatus} = crypto; // Pragma: allowlist secret
    if (typeof getSecretStorageStatus === "function") {
      try {
        status = await getSecretStorageStatus.call(crypto);
      } catch (error) {
        LogService.warn("MatrixClientLite", "Failed to read secret storage status:", error);
      }
    }

    const hasDefaultSecretStorageKey = Boolean(status?.defaultKeyId);
    const hasKnownInvalidSecrets = Object.values(status?.secretStorageKeyValidityMap ?? {}).some(
      (valid) => !valid,
    );
    let generatedRecoveryKey = false;
    const storedRecovery = this.loadStoredRecoveryKey();
    const stagedRecovery = this.stagedRecoveryKey;
    const sourceRecovery = stagedRecovery ?? storedRecovery;
    let recoveryKey: MatrixGeneratedSecretStorageKey | null = sourceRecovery
      ? {
          encodedPrivateKey: sourceRecovery.encodedPrivateKey,
          keyInfo: sourceRecovery.keyInfo,
          privateKey: new Uint8Array(Buffer.from(sourceRecovery.privateKeyBase64, "base64")),
        }
      : null;

    if (recoveryKey && status?.defaultKeyId) {
      const {defaultKeyId} = status;
      this.rememberSecretStorageKey(defaultKeyId, recoveryKey.privateKey, recoveryKey.keyInfo);
      if (!stagedRecovery && storedRecovery && storedRecovery.keyId !== defaultKeyId) {
        this.saveRecoveryKeyToDisk({
          encodedPrivateKey: recoveryKey.encodedPrivateKey,
          keyId: defaultKeyId,
          keyInfo: recoveryKey.keyInfo,
          privateKey: recoveryKey.privateKey,
        });
      }
    }

    const ensureRecoveryKey = async (): Promise<MatrixGeneratedSecretStorageKey> => {
      if (recoveryKey) {
        return recoveryKey;
      }
      if (typeof crypto.createRecoveryKeyFromPassphrase !== "function") {
        throw new Error(
          "Matrix crypto backend does not support recovery key generation (createRecoveryKeyFromPassphrase missing)",
        );
      }
      recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
      this.saveRecoveryKeyToDisk(recoveryKey);
      generatedRecoveryKey = true;
      return recoveryKey;
    };

    const shouldRecreateSecretStorage =
      options.forceNewSecretStorage === true ||
      !hasDefaultSecretStorageKey ||
      (!recoveryKey && status?.ready === false) ||
      hasKnownInvalidSecrets;

    if (hasKnownInvalidSecrets) {
      // Existing secret storage keys can't decrypt required secrets. Generate a fresh recovery key.
      recoveryKey = null;
    }

    const secretStorageOptions: {
      createSecretStorageKey?: () => Promise<MatrixGeneratedSecretStorageKey>;
      setupNewSecretStorage?: boolean;
      setupNewKeyBackup?: boolean;
    } = {
      setupNewKeyBackup: options.setupNewKeyBackup === true,
    };

    if (shouldRecreateSecretStorage) {
      secretStorageOptions.setupNewSecretStorage = true;
      secretStorageOptions.createSecretStorageKey = ensureRecoveryKey;
    }

    try {
      await crypto.bootstrapSecretStorage(secretStorageOptions);
    } catch (error) {
      const shouldRecreateWithoutRecoveryKey =
        options.allowSecretStorageRecreateWithoutRecoveryKey === true &&
        hasDefaultSecretStorageKey &&
        isRepairableSecretStorageAccessError(error);
      if (!shouldRecreateWithoutRecoveryKey) {
        throw error;
      }

      recoveryKey = null;
      LogService.warn(
        "MatrixClientLite",
        "Secret storage exists on the server but local recovery material cannot unlock it; recreating secret storage during explicit bootstrap.",
      );
      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: ensureRecoveryKey,
        setupNewKeyBackup: options.setupNewKeyBackup === true,
        setupNewSecretStorage: true,
      });
    }

    if (generatedRecoveryKey && this.recoveryKeyPath) {
      LogService.warn(
        "MatrixClientLite",
        `Generated Matrix recovery key and saved it to ${this.recoveryKeyPath}. Keep this file secure.`,
      );
    }
  }

  private clearStagedRecoveryKeyTracking(): void {
    this.stagedRecoveryKey = null;
    this.stagedCacheKeyIds.clear();
  }

  private rememberSecretStorageKey(
    keyId: string,
    key: Uint8Array,
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"],
  ): void {
    if (!keyId.trim()) {
      return;
    }
    this.secretStorageKeyCache.set(keyId, {
      key: new Uint8Array(key),
      keyInfo,
    });
  }

  private loadStoredRecoveryKey(): MatrixStoredRecoveryKey | null {
    if (!this.recoveryKeyPath) {
      return null;
    }
    try {
      if (!fs.existsSync(this.recoveryKeyPath)) {
        return null;
      }
      const raw = fs.readFileSync(this.recoveryKeyPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MatrixStoredRecoveryKey>;
      if (
        parsed.version !== 1 ||
        typeof parsed.createdAt !== "string" ||
        typeof parsed.privateKeyBase64 !== "string" || // Pragma: allowlist secret
        !parsed.privateKeyBase64.trim()
      ) {
        return null;
      }
      return {
        createdAt: parsed.createdAt,
        encodedPrivateKey:
          typeof parsed.encodedPrivateKey === "string" ? parsed.encodedPrivateKey : undefined,
        keyId: typeof parsed.keyId === "string" ? parsed.keyId : null,
        keyInfo:
          parsed.keyInfo && typeof parsed.keyInfo === "object"
            ? {
                name: typeof parsed.keyInfo.name === "string" ? parsed.keyInfo.name : undefined,
                passphrase: parsed.keyInfo.passphrase,
              }
            : undefined,
        privateKeyBase64: parsed.privateKeyBase64,
        version: 1,
      };
    } catch {
      return null;
    }
  }

  private saveRecoveryKeyToDisk(params: MatrixGeneratedSecretStorageKey): void {
    if (!this.recoveryKeyPath) {
      return;
    }
    try {
      const payload: MatrixStoredRecoveryKey = {
        createdAt: new Date().toISOString(),
        encodedPrivateKey: params.encodedPrivateKey,
        keyId: typeof params.keyId === "string" ? params.keyId : null,
        keyInfo: params.keyInfo
          ? {
              name: params.keyInfo.name,
              passphrase: params.keyInfo.passphrase,
            }
          : undefined,
        privateKeyBase64: Buffer.from(params.privateKey).toString("base64"),
        version: 1,
      };
      fs.mkdirSync(path.dirname(this.recoveryKeyPath), { recursive: true });
      fs.writeFileSync(this.recoveryKeyPath, JSON.stringify(payload, null, 2), "utf8");
      fs.chmodSync(this.recoveryKeyPath, 0o600);
    } catch (error) {
      LogService.warn("MatrixClientLite", "Failed to persist recovery key:", error);
    }
  }
}
