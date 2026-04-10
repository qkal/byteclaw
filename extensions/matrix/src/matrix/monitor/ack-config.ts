import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { type OpenClawConfig, resolveAckReaction } from "./runtime-api.js";

type MatrixAckReactionScope = "group-mentions" | "group-all" | "direct" | "all" | "none" | "off";

export function resolveMatrixAckReactionConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
}): { ackReaction: string; ackReactionScope: MatrixAckReactionScope } {
  const matrixConfig = params.cfg.channels?.matrix;
  const accountConfig = resolveMatrixAccountConfig({
    accountId: params.accountId,
    cfg: params.cfg as CoreConfig,
  });
  const ackReaction = resolveAckReaction(params.cfg, params.agentId, {
    accountId: params.accountId ?? undefined,
    channel: "matrix",
  }).trim();
  const ackReactionScope = (accountConfig.ackReactionScope ??
    matrixConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions") as MatrixAckReactionScope;
  return { ackReaction, ackReactionScope };
}
