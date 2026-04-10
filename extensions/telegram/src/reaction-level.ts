import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type ResolvedReactionLevel as BaseResolvedReactionLevel,
  type ReactionLevel,
  resolveReactionLevel,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveTelegramAccount } from "./accounts.js";

export type TelegramReactionLevel = ReactionLevel;
export type ResolvedReactionLevel = BaseResolvedReactionLevel;

/**
 * Resolve the effective reaction level and its implications.
 */
export function resolveTelegramReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedReactionLevel {
  const account = resolveTelegramAccount({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  return resolveReactionLevel({
    defaultLevel: "minimal",
    invalidFallback: "ack",
    value: account.config.reactionLevel,
  });
}
