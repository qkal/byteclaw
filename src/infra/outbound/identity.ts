import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export interface OutboundIdentity {
  name?: string;
  avatarUrl?: string;
  emoji?: string;
  theme?: string;
}

export function normalizeOutboundIdentity(
  identity?: OutboundIdentity | null,
): OutboundIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const name = normalizeOptionalString(identity.name);
  const avatarUrl = normalizeOptionalString(identity.avatarUrl);
  const emoji = normalizeOptionalString(identity.emoji);
  const theme = normalizeOptionalString(identity.theme);
  if (!name && !avatarUrl && !emoji && !theme) {
    return undefined;
  }
  return { avatarUrl, emoji, name, theme };
}

export function resolveAgentOutboundIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): OutboundIdentity | undefined {
  const agentIdentity = resolveAgentIdentity(cfg, agentId);
  const avatar = resolveAgentAvatar(cfg, agentId);
  return normalizeOutboundIdentity({
    avatarUrl: avatar.kind === "remote" ? avatar.url : undefined,
    emoji: agentIdentity?.emoji,
    name: agentIdentity?.name,
    theme: agentIdentity?.theme,
  });
}
