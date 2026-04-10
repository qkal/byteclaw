import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  type ResolvedMatrixAccount,
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  resolveMatrixAccountConfig,
} from "./matrix/accounts.js";
import { normalizeMatrixAllowList } from "./matrix/monitor/allowlist.js";
import type { CoreConfig } from "./types.js";

export { DEFAULT_ACCOUNT_ID };

export const matrixConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMatrixAccount,
  ReturnType<typeof resolveMatrixAccountConfig>,
  CoreConfig
>({
  clearBaseFields: [
    "name",
    "homeserver",
    "network",
    "proxy",
    "userId",
    "accessToken",
    "password",
    "deviceId",
    "deviceName",
    "avatarUrl",
    "initialSyncLimit",
  ],
  defaultAccountId: resolveDefaultMatrixAccountId,
  formatAllowFrom: (allowFrom) => normalizeMatrixAllowList(allowFrom),
  listAccountIds: listMatrixAccountIds,
  resolveAccessorAccount: ({ cfg, accountId }) => resolveMatrixAccountConfig({ accountId, cfg }),
  resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
  resolveAllowFrom: (account) => account.dm?.allowFrom,
  sectionKey: "matrix",
});
