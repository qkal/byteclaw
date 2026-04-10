import { ToolAuthorizationError } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

export function resolveAuthorizedWhatsAppOutboundTarget(params: {
  cfg: OpenClawConfig;
  chatJid: string;
  accountId?: string;
  actionLabel: string;
}): { to: string; accountId: string } {
  const account = resolveWhatsAppAccount({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  const resolution = resolveWhatsAppOutboundTarget({
    allowFrom: account.allowFrom ?? [],
    mode: "implicit",
    to: params.chatJid,
  });
  if (!resolution.ok) {
    throw new ToolAuthorizationError(
      `WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not in the configured allowFrom list for account "${account.accountId}".`,
    );
  }
  return { accountId: account.accountId, to: resolution.to };
}
