import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "./runtime-api.js";
import type { ResolvedQaChannelAccount } from "./types.js";

export const qaChannelStatus = createComputedAccountStatusAdapter<ResolvedQaChannelAccount>({
  buildChannelSummary: ({ snapshot }) => ({
    baseUrl: snapshot.baseUrl ?? "[missing]",
  }),
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
  resolveAccountSnapshot: ({ account }) => ({
    accountId: account.accountId,
    configured: account.configured,
    enabled: account.enabled,
    extra: {
      baseUrl: account.baseUrl || "[missing]",
      botUserId: account.botUserId,
    },
    name: account.name,
  }),
});
