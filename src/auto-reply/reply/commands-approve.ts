import {
  getChannelPlugin,
  resolveChannelApprovalCapability,
} from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { isApprovalNotFoundError } from "../../infra/approval-errors.js";
import { resolveApprovalCommandAuthorization } from "../../infra/channel-approval-auth.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { resolveChannelAccountId } from "./channel-context.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/?approve(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/approve@([^\s]+)(?:\s|$)/i;

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  "allow-always": "allow-always",
  "allow-once": "allow-once",
  allowalways: "allow-always",
  allowonce: "allow-once",
  always: "allow-always",
  block: "deny",
  deny: "deny",
  once: "allow-once",
  reject: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

const APPROVE_USAGE_TEXT =
  "Usage: /approve <id> <decision> (see the pending approval message for available decisions)";

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return { error: "❌ This /approve command targets a different Telegram bot.", ok: false };
  }
  const commandMatch = trimmed.match(COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const rest = trimmed.slice(commandMatch[0].length).trim();
  if (!rest) {
    return { error: APPROVE_USAGE_TEXT, ok: false };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { error: APPROVE_USAGE_TEXT, ok: false };
  }

  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  const second = normalizeLowercaseStringOrEmpty(tokens[1]);

  if (DECISION_ALIASES[first]) {
    return {
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
      ok: true,
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      decision: DECISION_ALIASES[second],
      id: tokens[0],
      ok: true,
    };
  }
  return { error: APPROVE_USAGE_TEXT, ok: false };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const {channel} = params.command;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

function formatApprovalSubmitError(error: unknown): string {
  return formatErrorMessage(error);
}

type ApprovalMethod = "exec.approval.resolve" | "plugin.approval.resolve";

function resolveApprovalMethods(params: {
  approvalId: string;
  execAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
  pluginAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
}): ApprovalMethod[] {
  if (params.approvalId.startsWith("plugin:")) {
    return params.pluginAuthorization.authorized ? ["plugin.approval.resolve"] : [];
  }
  if (params.execAuthorization.authorized && params.pluginAuthorization.authorized) {
    return ["exec.approval.resolve", "plugin.approval.resolve"];
  }
  if (params.execAuthorization.authorized) {
    return ["exec.approval.resolve"];
  }
  if (params.pluginAuthorization.authorized) {
    return ["plugin.approval.resolve"];
  }
  return [];
}

function resolveApprovalAuthorizationError(params: {
  approvalId: string;
  execAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
  pluginAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
}): string {
  if (params.approvalId.startsWith("plugin:")) {
    return (
      params.pluginAuthorization.reason ?? "❌ You are not authorized to approve this request."
    );
  }
  return (
    params.execAuthorization.reason ??
    params.pluginAuthorization.reason ??
    "❌ You are not authorized to approve this request."
  );
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return { reply: { text: parsed.error }, shouldContinue: false };
  }

  const isPluginId = parsed.id.startsWith("plugin:");
  const effectiveAccountId = resolveChannelAccountId({
    cfg: params.cfg,
    command: params.command,
    ctx: params.ctx,
  });
  const approvalCapability = resolveChannelApprovalCapability(
    getChannelPlugin(params.command.channel),
  );
  const approveCommandBehavior = approvalCapability?.resolveApproveCommandBehavior?.({
    accountId: effectiveAccountId,
    approvalKind: isPluginId ? "plugin" : "exec",
    cfg: params.cfg,
    senderId: params.command.senderId,
  });
  if (approveCommandBehavior?.kind === "ignore") {
    return { shouldContinue: false };
  }
  if (approveCommandBehavior?.kind === "reply") {
    return { reply: { text: approveCommandBehavior.text }, shouldContinue: false };
  }
  const execApprovalAuthorization = resolveApprovalCommandAuthorization({
    accountId: effectiveAccountId,
    cfg: params.cfg,
    channel: params.command.channel,
    kind: "exec",
    senderId: params.command.senderId,
  });
  const pluginApprovalAuthorization = resolveApprovalCommandAuthorization({
    accountId: effectiveAccountId,
    cfg: params.cfg,
    channel: params.command.channel,
    kind: "plugin",
    senderId: params.command.senderId,
  });
  const hasExplicitApprovalAuthorization =
    (execApprovalAuthorization.explicit && execApprovalAuthorization.authorized) ||
    (pluginApprovalAuthorization.explicit && pluginApprovalAuthorization.authorized);
  if (!params.command.isAuthorizedSender && !hasExplicitApprovalAuthorization) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const missingScope = requireGatewayClientScopeForInternalChannel(params, {
    allowedScopes: ["operator.approvals", "operator.admin"],
    label: "/approve",
    missingText: "❌ /approve requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }

  const resolvedBy = buildResolvedByLabel(params);
  const callApprovalMethod = async (method: string): Promise<void> => {
    await callGateway({
      clientDisplayName: `Chat approval (${resolvedBy})`,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      method,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      params: { decision: parsed.decision, id: parsed.id },
    });
  };

  const methods = resolveApprovalMethods({
    approvalId: parsed.id,
    execAuthorization: execApprovalAuthorization,
    pluginAuthorization: pluginApprovalAuthorization,
  });
  if (methods.length === 0) {
    return {
      reply: {
        text: resolveApprovalAuthorizationError({
          approvalId: parsed.id,
          execAuthorization: execApprovalAuthorization,
          pluginAuthorization: pluginApprovalAuthorization,
        }),
      },
      shouldContinue: false,
    };
  }

  let lastError: unknown = null;
  for (const [index, method] of methods.entries()) {
    try {
      await callApprovalMethod(method);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const isLastMethod = index === methods.length - 1;
      if (!isApprovalNotFoundError(error) || isLastMethod) {
        return {
          reply: { text: `❌ Failed to submit approval: ${formatApprovalSubmitError(error)}` },
          shouldContinue: false,
        };
      }
    }
  }

  if (lastError) {
    return {
      reply: { text: `❌ Failed to submit approval: ${formatApprovalSubmitError(lastError)}` },
      shouldContinue: false,
    };
  }

  return {
    reply: { text: `✅ Approval ${parsed.decision} submitted for ${parsed.id}.` },
    shouldContinue: false,
  };
};
