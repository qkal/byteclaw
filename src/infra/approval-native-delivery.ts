import type {
  ChannelApprovalKind,
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeSurface,
  ChannelApprovalNativeTarget,
} from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export interface ChannelApprovalNativePlannedTarget {
  surface: ChannelApprovalNativeSurface;
  target: ChannelApprovalNativeTarget;
  reason: "preferred" | "fallback";
}

export interface ChannelApprovalNativeDeliveryPlan {
  targets: ChannelApprovalNativePlannedTarget[];
  originTarget: ChannelApprovalNativeTarget | null;
  notifyOriginWhenDmOnly: boolean;
}

function dedupeTargets(
  targets: ChannelApprovalNativePlannedTarget[],
): ChannelApprovalNativePlannedTarget[] {
  const seen = new Set<string>();
  const deduped: ChannelApprovalNativePlannedTarget[] = [];
  for (const target of targets) {
    const key = buildChannelApprovalNativeTargetKey(target.target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

export async function resolveChannelNativeApprovalDeliveryPlan(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
  adapter?: ChannelApprovalNativeAdapter | null;
}): Promise<ChannelApprovalNativeDeliveryPlan> {
  const {adapter} = params;
  if (!adapter) {
    return {
      notifyOriginWhenDmOnly: false,
      originTarget: null,
      targets: [],
    };
  }

  const capabilities = adapter.describeDeliveryCapabilities({
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    cfg: params.cfg,
    request: params.request,
  });
  if (!capabilities.enabled) {
    return {
      notifyOriginWhenDmOnly: false,
      originTarget: null,
      targets: [],
    };
  }

  const originTarget =
    capabilities.supportsOriginSurface && adapter.resolveOriginTarget
      ? ((await adapter.resolveOriginTarget({
          accountId: params.accountId,
          approvalKind: params.approvalKind,
          cfg: params.cfg,
          request: params.request,
        })) ?? null)
      : null;
  const approverDmTargets =
    capabilities.supportsApproverDmSurface && adapter.resolveApproverDmTargets
      ? await adapter.resolveApproverDmTargets({
          accountId: params.accountId,
          approvalKind: params.approvalKind,
          cfg: params.cfg,
          request: params.request,
        })
      : [];

  const plannedTargets: ChannelApprovalNativePlannedTarget[] = [];
  const preferOrigin =
    capabilities.preferredSurface === "origin" || capabilities.preferredSurface === "both";
  const preferApproverDm =
    capabilities.preferredSurface === "approver-dm" || capabilities.preferredSurface === "both";

  if (preferOrigin && originTarget) {
    plannedTargets.push({
      reason: "preferred",
      surface: "origin",
      target: originTarget,
    });
  }

  if (preferApproverDm) {
    for (const target of approverDmTargets) {
      plannedTargets.push({
        reason: "preferred",
        surface: "approver-dm",
        target,
      });
    }
  } else if (!originTarget) {
    for (const target of approverDmTargets) {
      plannedTargets.push({
        reason: "fallback",
        surface: "approver-dm",
        target,
      });
    }
  }

  return {
    notifyOriginWhenDmOnly:
      capabilities.preferredSurface === "approver-dm" &&
      capabilities.notifyOriginWhenDmOnly === true &&
      originTarget !== null,
    originTarget,
    targets: dedupeTargets(plannedTargets),
  };
}
