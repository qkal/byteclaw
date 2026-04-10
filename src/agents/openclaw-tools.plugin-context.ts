import type { OpenClawConfig } from "../config/config.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export interface OpenClawPluginToolOptions {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  fsPolicy?: ToolFsPolicy;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
  sessionId?: string;
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  sandboxed?: boolean;
  allowGatewaySubagentBinding?: boolean;
}

export function resolveOpenClawPluginToolInputs(params: {
  options?: OpenClawPluginToolOptions;
  resolvedConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
}) {
  const { options, resolvedConfig, runtimeConfig } = params;
  const sessionAgentId = resolveSessionAgentId({
    config: resolvedConfig,
    sessionKey: options?.agentSessionKey,
  });
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const deliveryContext = normalizeDeliveryContext({
    accountId: options?.agentAccountId,
    channel: options?.agentChannel,
    threadId: options?.agentThreadId,
    to: options?.agentTo,
  });

  return {
    allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
    context: {
      agentAccountId: options?.agentAccountId,
      agentDir: options?.agentDir,
      agentId: sessionAgentId,
      browser: {
        allowHostControl: options?.allowHostBrowserControl,
        sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      },
      config: options?.config,
      deliveryContext,
      fsPolicy: options?.fsPolicy,
      messageChannel: options?.agentChannel,
      requesterSenderId: options?.requesterSenderId ?? undefined,
      runtimeConfig,
      sandboxed: options?.sandboxed,
      senderIsOwner: options?.senderIsOwner ?? undefined,
      sessionId: options?.sessionId,
      sessionKey: options?.agentSessionKey,
      workspaceDir,
    },
  };
}
