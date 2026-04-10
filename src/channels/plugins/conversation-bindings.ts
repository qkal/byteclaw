import type { OpenClawConfig } from "../../config/config.js";
import { getChannelPlugin } from "./registry.js";
import type { ChannelId } from "./types.js";

export async function createChannelConversationBindingManager(params: {
  channelId: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<{ stop: () => void | Promise<void> } | null> {
  const createManager = getChannelPlugin(params.channelId)?.conversationBindings?.createManager;
  if (!createManager) {
    return null;
  }
  return await createManager({
    accountId: params.accountId,
    cfg: params.cfg,
  });
}

export function setChannelConversationBindingIdleTimeoutBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  idleTimeoutMs: number;
}): {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}[] {
  const setIdleTimeoutBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
    ?.setIdleTimeoutBySessionKey;
  if (!setIdleTimeoutBySessionKey) {
    return [];
  }
  return setIdleTimeoutBySessionKey({
    accountId: params.accountId,
    idleTimeoutMs: params.idleTimeoutMs,
    targetSessionKey: params.targetSessionKey,
  });
}

export function setChannelConversationBindingMaxAgeBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  maxAgeMs: number;
}): {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}[] {
  const setMaxAgeBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
    ?.setMaxAgeBySessionKey;
  if (!setMaxAgeBySessionKey) {
    return [];
  }
  return setMaxAgeBySessionKey({
    accountId: params.accountId,
    maxAgeMs: params.maxAgeMs,
    targetSessionKey: params.targetSessionKey,
  });
}
