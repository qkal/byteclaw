import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  migrateLegacyFlatAllowPrivateNetworkAlias,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "./record-shared.js";

function hasLegacyMatrixRoomAllowAlias(value: unknown): boolean {
  const room = isRecord(value) ? value : null;
  return Boolean(room && typeof room.allow === "boolean");
}

function hasLegacyMatrixRoomMapAllowAliases(value: unknown): boolean {
  const rooms = isRecord(value) ? value : null;
  return Boolean(rooms && Object.values(rooms).some((room) => hasLegacyMatrixRoomAllowAlias(room)));
}

function hasLegacyMatrixAccountRoomAllowAliases(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => {
    if (!isRecord(account)) {
      return false;
    }
    return (
      hasLegacyMatrixRoomMapAllowAliases(account.groups) ||
      hasLegacyMatrixRoomMapAllowAliases(account.rooms)
    );
  });
}

function hasLegacyMatrixAccountPrivateNetworkAliases(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) =>
    hasLegacyFlatAllowPrivateNetworkAlias(isRecord(account) ? account : {}),
  );
}

function hasLegacyTrustedDmPolicy(value: unknown): boolean {
  const root = isRecord(value) ? value : null;
  if (!root) {
    return false;
  }
  const dm = isRecord(root.dm) ? root.dm : null;
  return dm?.policy === "trusted";
}

function hasLegacyMatrixAccountTrustedDmPolicies(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyTrustedDmPolicy(account));
}

function migrateLegacyTrustedDmPolicy(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const dm = isRecord(params.entry.dm) ? params.entry.dm : null;
  if (!dm || dm.policy !== "trusted") {
    return { changed: false, entry: params.entry };
  }
  const allowFromRaw = dm.allowFrom;
  // Trim before counting: downstream allowlist normalization drops whitespace-only
  // Entries, so a config like ["   "] must still fall back to "pairing"
  // Instead of becoming an effectively empty allowlist.
  const allowFromEntries = Array.isArray(allowFromRaw)
    ? allowFromRaw.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      ).length
    : 0;
  // Preserve the operator's existing trust boundary when an explicit allowFrom
  // List is present; only fall back to pairing when the effective allowlist is
  // Empty.
  const nextPolicy: "allowlist" | "pairing" = allowFromEntries > 0 ? "allowlist" : "pairing";
  const nextDm = { ...dm, policy: nextPolicy };
  params.changes.push(
    `Migrated ${params.pathPrefix}.dm.policy "trusted" → "${nextPolicy}" (legacy alias removed; ` +
      `${allowFromEntries > 0 ? `preserved ${allowFromEntries} ${params.pathPrefix}.dm.allowFrom ${allowFromEntries === 1 ? "entry" : "entries"}` : "no allowFrom entries present, defaulting to pairing for safety"}).`,
  );
  return { changed: true, entry: { ...params.entry, dm: nextDm } };
}

function normalizeMatrixRoomAllowAliases(params: {
  rooms: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { rooms: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextRooms: Record<string, unknown> = { ...params.rooms };
  for (const [roomId, roomValue] of Object.entries(params.rooms)) {
    const room = isRecord(roomValue) ? roomValue : null;
    if (!room || typeof room.allow !== "boolean") {
      continue;
    }
    const nextRoom = { ...room };
    if (typeof nextRoom.enabled !== "boolean") {
      nextRoom.enabled = room.allow;
    }
    delete nextRoom.allow;
    nextRooms[roomId] = nextRoom;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.${roomId}.allow → ${params.pathPrefix}.${roomId}.enabled (${String(nextRoom.enabled)}).`,
    );
  }
  return { changed, rooms: nextRooms };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {}),
    message:
      'channels.matrix.allowPrivateNetwork is legacy; use channels.matrix.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    path: ["channels", "matrix"],
  },
  {
    match: hasLegacyMatrixAccountPrivateNetworkAliases,
    message:
      'channels.matrix.accounts.<id>.allowPrivateNetwork is legacy; use channels.matrix.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    path: ["channels", "matrix", "accounts"],
  },
  {
    match: hasLegacyMatrixRoomMapAllowAliases,
    message:
      'channels.matrix.groups.<room>.allow is legacy; use channels.matrix.groups.<room>.enabled instead. Run "openclaw doctor --fix".',
    path: ["channels", "matrix", "groups"],
  },
  {
    match: hasLegacyMatrixRoomMapAllowAliases,
    message:
      'channels.matrix.rooms.<room>.allow is legacy; use channels.matrix.rooms.<room>.enabled instead. Run "openclaw doctor --fix".',
    path: ["channels", "matrix", "rooms"],
  },
  {
    match: hasLegacyMatrixAccountRoomAllowAliases,
    message:
      'channels.matrix.accounts.<id>.{groups,rooms}.<room>.allow is legacy; use channels.matrix.accounts.<id>.{groups,rooms}.<room>.enabled instead. Run "openclaw doctor --fix".',
    path: ["channels", "matrix", "accounts"],
  },
  {
    match: hasLegacyTrustedDmPolicy,
    message:
      'channels.matrix.dm.policy "trusted" is legacy; use "allowlist" (with allowFrom entries) or "pairing" instead. Run "openclaw doctor --fix".',
    path: ["channels", "matrix"],
  },
  {
    match: hasLegacyMatrixAccountTrustedDmPolicies,
    message:
      'channels.matrix.accounts.<id>.dm.policy "trusted" is legacy; use "allowlist" (with allowFrom entries) or "pairing" instead. Run "openclaw doctor --fix".',
    path: ["channels", "matrix", "accounts"],
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  const matrix = isRecord(channels?.matrix) ? channels.matrix : null;
  if (!matrix) {
    return { changes: [], config: cfg };
  }

  const changes: string[] = [];
  let updatedMatrix: Record<string, unknown> = matrix;
  let changed = false;

  const topLevelPrivateNetwork = migrateLegacyFlatAllowPrivateNetworkAlias({
    changes,
    entry: updatedMatrix,
    pathPrefix: "channels.matrix",
  });
  updatedMatrix = topLevelPrivateNetwork.entry;
  changed = changed || topLevelPrivateNetwork.changed;

  const topLevelTrustedDmPolicy = migrateLegacyTrustedDmPolicy({
    changes,
    entry: updatedMatrix,
    pathPrefix: "channels.matrix",
  });
  updatedMatrix = topLevelTrustedDmPolicy.entry;
  changed = changed || topLevelTrustedDmPolicy.changed;

  const normalizeTopLevelRoomScope = (key: "groups" | "rooms") => {
    const rooms = isRecord(updatedMatrix[key]) ? updatedMatrix[key] : null;
    if (!rooms) {
      return;
    }
    const normalized = normalizeMatrixRoomAllowAliases({
      changes,
      pathPrefix: `channels.matrix.${key}`,
      rooms,
    });
    if (normalized.changed) {
      updatedMatrix = { ...updatedMatrix, [key]: normalized.rooms };
      changed = true;
    }
  };

  normalizeTopLevelRoomScope("groups");
  normalizeTopLevelRoomScope("rooms");

  const accounts = isRecord(updatedMatrix.accounts) ? updatedMatrix.accounts : null;
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts: Record<string, unknown> = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = isRecord(accountValue) ? accountValue : null;
      if (!account) {
        continue;
      }
      let nextAccount: Record<string, unknown> = account;
      let accountChanged = false;

      const privateNetworkMigration = migrateLegacyFlatAllowPrivateNetworkAlias({
        changes,
        entry: nextAccount,
        pathPrefix: `channels.matrix.accounts.${accountId}`,
      });
      if (privateNetworkMigration.changed) {
        nextAccount = privateNetworkMigration.entry;
        accountChanged = true;
      }

      const accountTrustedDmPolicy = migrateLegacyTrustedDmPolicy({
        changes,
        entry: nextAccount,
        pathPrefix: `channels.matrix.accounts.${accountId}`,
      });
      if (accountTrustedDmPolicy.changed) {
        nextAccount = accountTrustedDmPolicy.entry;
        accountChanged = true;
      }

      for (const key of ["groups", "rooms"] as const) {
        const rooms = isRecord(nextAccount[key]) ? nextAccount[key] : null;
        if (!rooms) {
          continue;
        }
        const normalized = normalizeMatrixRoomAllowAliases({
          changes,
          pathPrefix: `channels.matrix.accounts.${accountId}.${key}`,
          rooms,
        });
        if (normalized.changed) {
          nextAccount = { ...nextAccount, [key]: normalized.rooms };
          accountChanged = true;
        }
      }
      if (accountChanged) {
        nextAccounts[accountId] = nextAccount;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updatedMatrix = { ...updatedMatrix, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return { changes: [], config: cfg };
  }
  return {
    changes,
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        matrix: updatedMatrix as NonNullable<OpenClawConfig["channels"]>["matrix"],
      },
    },
  };
}
