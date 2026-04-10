import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type ReactionLevel,
  type ResolvedReactionLevel,
  resolveReactionLevel,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";

export type WhatsAppReactionLevel = ReactionLevel;
export type ResolvedWhatsAppReactionLevel = ResolvedReactionLevel;

/** Resolve the effective reaction level and its implications for WhatsApp. */
export function resolveWhatsAppReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedWhatsAppReactionLevel {
  const account = resolveMergedWhatsAppAccountConfig({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  return resolveReactionLevel({
    defaultLevel: "minimal",
    invalidFallback: "minimal",
    value: account.reactionLevel,
  });
}
