import { doesApprovalRequestMatchChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "./approval-runtime.js";
import { getDiscordExecApprovalApprovers } from "./exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export function shouldHandleDiscordApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const config =
    params.configOverride ??
    resolveDiscordAccount({ accountId: params.accountId, cfg: params.cfg }).config.execApprovals;
  const approvers = getDiscordExecApprovalApprovers({
    accountId: params.accountId,
    cfg: params.cfg,
    configOverride: params.configOverride,
  });
  if (
    !doesApprovalRequestMatchChannelAccount({
      accountId: params.accountId,
      cfg: params.cfg,
      channel: "discord",
      request: params.request,
    })
  ) {
    return false;
  }
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      approverCount: approvers.length,
      enabled: config?.enabled,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    agentFilter: config?.agentFilter,
    request: params.request.request,
    sessionFilter: config?.sessionFilter,
  });
}
