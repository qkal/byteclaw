import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/infra-runtime";

export interface ResolveTelegramExecApprovalParams {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  allowPluginFallback?: boolean;
  gatewayUrl?: string;
}

export async function resolveTelegramExecApproval(
  params: ResolveTelegramExecApprovalParams,
): Promise<void> {
  await resolveApprovalOverGateway({
    allowPluginFallback: params.allowPluginFallback,
    approvalId: params.approvalId,
    cfg: params.cfg,
    clientDisplayName: `Telegram approval (${params.senderId?.trim() || "unknown"})`,
    decision: params.decision,
    gatewayUrl: params.gatewayUrl,
    senderId: params.senderId,
  });
}
