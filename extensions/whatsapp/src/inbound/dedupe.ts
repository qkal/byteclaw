import { createDedupeCache } from "openclaw/plugin-sdk/core";

const RECENT_WEB_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_WEB_MESSAGE_MAX = 5000;
const RECENT_OUTBOUND_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_OUTBOUND_MESSAGE_MAX = 5000;

const recentInboundMessages = createDedupeCache({
  maxSize: RECENT_WEB_MESSAGE_MAX,
  ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
});
const recentOutboundMessages = createDedupeCache({
  maxSize: RECENT_OUTBOUND_MESSAGE_MAX,
  ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
});

function buildMessageKey(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): string | null {
  const accountId = params.accountId.trim();
  const remoteJid = params.remoteJid.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

export function resetWebInboundDedupe(): void {
  recentInboundMessages.clear();
  recentOutboundMessages.clear();
}

export function isRecentInboundMessage(key: string): boolean {
  return recentInboundMessages.check(key);
}

export function rememberRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): void {
  const key = buildMessageKey(params);
  if (!key) {
    return;
  }
  recentOutboundMessages.check(key);
}

export function isRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): boolean {
  const key = buildMessageKey(params);
  if (!key) {
    return false;
  }
  return recentOutboundMessages.peek(key);
}
