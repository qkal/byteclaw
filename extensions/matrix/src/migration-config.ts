import fs from "node:fs";
import os from "node:os";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  findMatrixAccountEntry,
  requiresExplicitMatrixDefaultAccount,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixChannelConfig,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./account-selection.js";
import { resolveMatrixAccountStringValues } from "./auth-precedence.js";
import {
  resolveGlobalMatrixEnvConfig,
  resolveScopedMatrixEnvConfig,
} from "./matrix/client/env-auth.js";
import { resolveMatrixAccountStorageRoot, resolveMatrixCredentialsPath } from "./storage-paths.js";

export interface MatrixStoredCredentials {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
}

export interface MatrixMigrationAccountTarget {
  accountId: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  rootDir: string;
  storedDeviceId: string | null;
}

export type MatrixLegacyFlatStoreTarget = MatrixMigrationAccountTarget & {
  selectionNote?: string;
};

type MatrixLegacyFlatStoreKind = "state" | "encrypted state";

function clean(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function resolveMatrixAccountConfigEntry(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> | null {
  return findMatrixAccountEntry(cfg, accountId);
}

function resolveMatrixFlatStoreSelectionNote(
  cfg: OpenClawConfig,
  accountId: string,
): string | undefined {
  if (resolveConfiguredMatrixAccountIds(cfg).length <= 1) {
    return undefined;
  }
  return (
    `Legacy Matrix flat store uses one shared on-disk state, so it will be migrated into ` +
    `account "${accountId}".`
  );
}

export function resolveMatrixMigrationConfigFields(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): {
  homeserver: string;
  userId: string;
  accessToken: string;
} {
  const channel = resolveMatrixChannelConfig(params.cfg);
  const account = resolveMatrixAccountConfigEntry(params.cfg, params.accountId);
  const scopedEnv = resolveScopedMatrixEnvConfig(params.accountId, params.env);
  const globalEnv = resolveGlobalMatrixEnvConfig(params.env);
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const resolvedStrings = resolveMatrixAccountStringValues({
    account: {
      accessToken: clean(account?.accessToken),
      homeserver: clean(account?.homeserver),
      userId: clean(account?.userId),
    },
    accountId: normalizedAccountId,
    channel: {
      accessToken: clean(channel?.accessToken),
      homeserver: clean(channel?.homeserver),
      userId: clean(channel?.userId),
    },
    globalEnv,
    scopedEnv,
  });

  return {
    accessToken: resolvedStrings.accessToken,
    homeserver: resolvedStrings.homeserver,
    userId: resolvedStrings.userId,
  };
}

export function loadStoredMatrixCredentials(
  env: NodeJS.ProcessEnv,
  accountId: string,
): MatrixStoredCredentials | null {
  const stateDir = resolveStateDir(env, os.homedir);
  const credentialsPath = resolveMatrixCredentialsPath({
    accountId: normalizeAccountId(accountId),
    stateDir,
  });
  try {
    if (!fs.existsSync(credentialsPath)) {
      return null;
    }
    const parsed = JSON.parse(
      fs.readFileSync(credentialsPath, "utf8"),
    ) as Partial<MatrixStoredCredentials>;
    if (
      typeof parsed.homeserver !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.accessToken !== "string"
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      homeserver: parsed.homeserver,
      userId: parsed.userId,
    };
  } catch {
    return null;
  }
}

export function credentialsMatchResolvedIdentity(
  stored: MatrixStoredCredentials | null,
  identity: {
    homeserver: string;
    userId: string;
    accessToken: string;
  },
): stored is MatrixStoredCredentials {
  if (!stored || !identity.homeserver) {
    return false;
  }
  if (!identity.userId) {
    if (!identity.accessToken) {
      return false;
    }
    return stored.homeserver === identity.homeserver && stored.accessToken === identity.accessToken;
  }
  return stored.homeserver === identity.homeserver && stored.userId === identity.userId;
}

export function resolveMatrixMigrationAccountTarget(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): MatrixMigrationAccountTarget | null {
  const stored = loadStoredMatrixCredentials(params.env, params.accountId);
  const resolved = resolveMatrixMigrationConfigFields(params);
  const matchingStored = credentialsMatchResolvedIdentity(stored, {
    accessToken: resolved.accessToken,
    homeserver: resolved.homeserver,
    userId: resolved.userId,
  })
    ? stored
    : null;
  const {homeserver} = resolved;
  const userId = resolved.userId || matchingStored?.userId || "";
  const accessToken = resolved.accessToken || matchingStored?.accessToken || "";
  if (!homeserver || !userId || !accessToken) {
    return null;
  }

  const stateDir = resolveStateDir(params.env, os.homedir);
  const { rootDir } = resolveMatrixAccountStorageRoot({
    accessToken,
    accountId: params.accountId,
    homeserver,
    stateDir,
    userId,
  });

  return {
    accessToken,
    accountId: params.accountId,
    homeserver,
    rootDir,
    storedDeviceId: matchingStored?.deviceId ?? null,
    userId,
  };
}

export function resolveLegacyMatrixFlatStoreTarget(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  detectedPath: string;
  detectedKind: MatrixLegacyFlatStoreKind;
}): MatrixLegacyFlatStoreTarget | { warning: string } {
  const channel = resolveMatrixChannelConfig(params.cfg);
  if (!channel) {
    return {
      warning:
        `Legacy Matrix ${params.detectedKind} detected at ${params.detectedPath}, but channels.matrix is not configured yet. ` +
        'Configure Matrix, then rerun "openclaw doctor --fix" or restart the gateway.',
    };
  }
  if (requiresExplicitMatrixDefaultAccount(params.cfg)) {
    return {
      warning:
        `Legacy Matrix ${params.detectedKind} detected at ${params.detectedPath}, but multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set. ` +
        'Set "channels.matrix.defaultAccount" to the intended target account before rerunning "openclaw doctor --fix" or restarting the gateway.',
    };
  }

  const accountId = resolveMatrixDefaultOrOnlyAccountId(params.cfg);
  const target = resolveMatrixMigrationAccountTarget({
    accountId,
    cfg: params.cfg,
    env: params.env,
  });
  if (!target) {
    const targetDescription =
      params.detectedKind === "state"
        ? "the new account-scoped target"
        : "the account-scoped target";
    return {
      warning:
        `Legacy Matrix ${params.detectedKind} detected at ${params.detectedPath}, but ${targetDescription} could not be resolved yet ` +
        `(need homeserver, userId, and access token for channels.matrix${accountId === DEFAULT_ACCOUNT_ID ? "" : `.accounts.${accountId}`}). ` +
        'Start the gateway once with a working Matrix login, or rerun "openclaw doctor --fix" after cached credentials are available.',
    };
  }

  return {
    ...target,
    selectionNote: resolveMatrixFlatStoreSelectionNote(params.cfg, accountId),
  };
}
