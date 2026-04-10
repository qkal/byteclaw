import { type NormalizedUsage, deriveSessionTotalTokens } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

type PersistRunSessionUsageParams = Parameters<typeof persistSessionUsageUpdate>[0];

type IncrementRunCompactionCountParams = Omit<
  Parameters<typeof incrementCompactionCount>[0],
  "tokensAfter"
> & {
  amount?: number;
  cfg?: OpenClawConfig;
  lastCallUsage?: NormalizedUsage;
  contextTokensUsed?: number;
  newSessionId?: string;
};

export async function persistRunSessionUsage(params: PersistRunSessionUsageParams): Promise<void> {
  await persistSessionUsageUpdate(params);
}

export async function incrementRunCompactionCount(
  params: IncrementRunCompactionCountParams,
): Promise<number | undefined> {
  const tokensAfterCompaction = params.lastCallUsage
    ? deriveSessionTotalTokens({
        contextTokens: params.contextTokensUsed,
        usage: params.lastCallUsage,
      })
    : undefined;
  return incrementCompactionCount({
    amount: params.amount,
    cfg: params.cfg,
    newSessionId: params.newSessionId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    tokensAfter: tokensAfterCompaction,
  });
}
