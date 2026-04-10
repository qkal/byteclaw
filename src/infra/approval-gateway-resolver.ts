import type { OpenClawConfig } from "../config/config.js";
import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { isApprovalNotFoundError } from "./approval-errors.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";

export interface ResolveApprovalOverGatewayParams {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalDecision;
  senderId?: string | null;
  allowPluginFallback?: boolean;
  gatewayUrl?: string;
  clientDisplayName?: string;
}

export async function resolveApprovalOverGateway(
  params: ResolveApprovalOverGatewayParams,
): Promise<void> {
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady();
  };
  const failReady = (err: unknown) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(err);
  };

  const gatewayClient = await createOperatorApprovalsGatewayClient({
    clientDisplayName:
      params.clientDisplayName ?? `Approval (${params.senderId?.trim() || "unknown"})`,
    config: params.cfg,
    gatewayUrl: params.gatewayUrl,
    onClose: (code, reason) => {
      failReady(new Error(`gateway closed (${code}): ${reason}`));
    },
    onConnectError: failReady,
    onHelloOk: markReady,
  });

  try {
    gatewayClient.start();
    await ready;
    const requestResolve = async (method: "exec.approval.resolve" | "plugin.approval.resolve") => {
      await gatewayClient.request(method, {
        decision: params.decision,
        id: params.approvalId,
      });
    };
    if (params.approvalId.startsWith("plugin:")) {
      await requestResolve("plugin.approval.resolve");
      return;
    }
    try {
      await requestResolve("exec.approval.resolve");
    } catch (error) {
      if (!params.allowPluginFallback || !isApprovalNotFoundError(error)) {
        throw error;
      }
      await requestResolve("plugin.approval.resolve");
    }
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}
