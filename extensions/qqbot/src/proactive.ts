/**
 * QQ Bot proactive messaging helpers.
 *
 * This module sends proactive messages and manages known-user queries.
 * Known-user storage is delegated to `./known-users.ts`.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  getAccessToken,
  sendC2CImageMessage,
  sendGroupImageMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
} from "./api.js";
import { resolveDefaultQQBotAccountId, resolveQQBotAccount } from "./config.js";
import {
  clearKnownUsers as clearKnownUsersImpl,
  getKnownUser as getKnownUserImpl,
  listKnownUsers as listKnownUsersImpl,
  removeKnownUser as removeKnownUserImpl,
} from "./known-users.js";
import type { ResolvedQQBotAccount } from "./types.js";
import { debugError, debugLog } from "./utils/debug-log.js";

// Re-export known-user types and functions from the canonical module.
export {
  clearKnownUsers as clearKnownUsersFromStore,
  flushKnownUsers,
  getKnownUser as getKnownUserFromStore,
  listKnownUsers as listKnownUsersFromStore,
  recordKnownUser,
  removeKnownUser as removeKnownUserFromStore,
} from "./known-users.js";
export type { KnownUser } from "./known-users.js";

/** Options for proactive message sending. */
export interface ProactiveSendOptions {
  to: string;
  text: string;
  type?: "c2c" | "group" | "channel";
  imageUrl?: string;
  accountId?: string;
}

/** Result returned from proactive sends. */
export interface ProactiveSendResult {
  success: boolean;
  messageId?: string;
  timestamp?: number | string;
  error?: string;
}

/** Filters for listing known users. */
export interface ListKnownUsersOptions {
  type?: "c2c" | "group" | "channel";
  accountId?: string;
  sortByLastInteraction?: boolean;
  limit?: number;
}

/** Look up a known user entry (adapter for the old proactive API shape). */
export function getKnownUser(
  type: string,
  openid: string,
  accountId: string,
): ReturnType<typeof getKnownUserImpl> {
  return getKnownUserImpl(accountId, openid, type as "c2c" | "group");
}

/** List known users with optional filtering and sorting (adapter). */
export function listKnownUsers(
  options?: ListKnownUsersOptions,
): ReturnType<typeof listKnownUsersImpl> {
  const type = options?.type;
  return listKnownUsersImpl({
    accountId: options?.accountId,
    limit: options?.limit,
    sortBy: options?.sortByLastInteraction !== false ? "lastSeenAt" : undefined,
    sortOrder: "desc",
    type: type === "channel" ? undefined : type,
  });
}

/** Remove one known user entry (adapter). */
export function removeKnownUser(type: string, openid: string, accountId: string): boolean {
  return removeKnownUserImpl(accountId, openid, type as "c2c" | "group");
}

/** Clear all known users, optionally scoped to a single account (adapter). */
export function clearKnownUsers(accountId?: string): number {
  return clearKnownUsersImpl(accountId);
}

/** Resolve account config and send a proactive message. */
export async function sendProactive(
  options: ProactiveSendOptions,
  cfg: OpenClawConfig,
): Promise<ProactiveSendResult> {
  const {
    to,
    text,
    type = "c2c",
    imageUrl,
    accountId = resolveDefaultQQBotAccountId(cfg),
  } = options;

  const account = resolveQQBotAccount(cfg, accountId);

  if (!account.appId || !account.clientSecret) {
    return {
      error: "QQBot not configured (missing appId or clientSecret)",
      success: false,
    };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    if (imageUrl) {
      try {
        if (type === "c2c") {
          await sendC2CImageMessage(account.appId, accessToken, to, imageUrl, undefined, undefined);
        } else if (type === "group") {
          await sendGroupImageMessage(
            account.appId,
            accessToken,
            to,
            imageUrl,
            undefined,
            undefined,
          );
        }
        debugLog(`[qqbot:proactive] Sent image to ${type}:${to}`);
      } catch (error) {
        debugError(`[qqbot:proactive] Failed to send image: ${String(error)}`);
      }
    }

    let result: { id: string; timestamp: number | string };

    if (type === "c2c") {
      result = await sendProactiveC2CMessage(account.appId, accessToken, to, text);
    } else if (type === "group") {
      result = await sendProactiveGroupMessage(account.appId, accessToken, to, text);
    } else if (type === "channel") {
      return {
        error: "Channel proactive messages are not supported. Please use group or c2c.",
        success: false,
      };
    } else {
      return {
        error: `Unknown message type: ${String(type)}`,
        success: false,
      };
    }

    debugLog(`[qqbot:proactive] Sent message to ${type}:${to}, id: ${result.id}`);

    return {
      messageId: result.id,
      success: true,
      timestamp: result.timestamp,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    debugError(`[qqbot:proactive] Failed to send message: ${message}`);

    return {
      error: message,
      success: false,
    };
  }
}

/** Send one proactive message to each recipient. */
export async function sendBulkProactiveMessage(
  recipients: string[],
  text: string,
  type: "c2c" | "group",
  cfg: OpenClawConfig,
  accountId = resolveDefaultQQBotAccountId(cfg),
): Promise<{ to: string; result: ProactiveSendResult }[]> {
  const results: { to: string; result: ProactiveSendResult }[] = [];

  for (const to of recipients) {
    const result = await sendProactive({ accountId, text, to, type }, cfg);
    results.push({ result, to });

    // Add a small delay to reduce rate-limit pressure.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return results;
}

/**
 * Send a message to all known users.
 *
 * @param text Message content.
 * @param cfg OpenClaw config.
 * @param options Optional filters.
 * @returns Aggregate send statistics.
 */
export async function broadcastMessage(
  text: string,
  cfg: OpenClawConfig,
  options?: {
    type?: "c2c" | "group";
    accountId?: string;
    limit?: number;
  },
): Promise<{
  total: number;
  success: number;
  failed: number;
  results: { to: string; result: ProactiveSendResult }[];
}> {
  const users = listKnownUsers({
    accountId: options?.accountId,
    limit: options?.limit,
    sortByLastInteraction: true,
    type: options?.type,
  });

  // Channel recipients do not support proactive sends.
  const validUsers = users.filter((u) => u.type === "c2c" || u.type === "group");

  const results: { to: string; result: ProactiveSendResult }[] = [];
  let success = 0;
  let failed = 0;

  for (const user of validUsers) {
    const targetId = user.type === "group" ? (user.groupOpenid ?? user.openid) : user.openid;
    const result = await sendProactive(
      {
        accountId: user.accountId,
        text,
        to: targetId,
        type: user.type,
      },
      cfg,
    );

    results.push({ result, to: targetId });

    if (result.success) {
      success++;
    } else {
      failed++;
    }

    // Add a small delay to reduce rate-limit pressure.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    failed,
    results,
    success,
    total: validUsers.length,
  };
}

// Helpers.

/**
 * Send a proactive message using a resolved account without a full config object.
 *
 * @param account Resolved account configuration.
 * @param to Target openid.
 * @param text Message content.
 * @param type Message type.
 */
export async function sendProactiveMessageDirect(
  account: ResolvedQQBotAccount,
  to: string,
  text: string,
  type: "c2c" | "group" = "c2c",
): Promise<ProactiveSendResult> {
  if (!account.appId || !account.clientSecret) {
    return {
      error: "QQBot not configured (missing appId or clientSecret)",
      success: false,
    };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    let result: { id: string; timestamp: number | string };

    if (type === "c2c") {
      result = await sendProactiveC2CMessage(account.appId, accessToken, to, text);
    } else {
      result = await sendProactiveGroupMessage(account.appId, accessToken, to, text);
    }

    return {
      messageId: result.id,
      success: true,
      timestamp: result.timestamp,
    };
  } catch (error) {
    return {
      error: formatErrorMessage(error),
      success: false,
    };
  }
}

/**
 * Return known-user counts for the selected account.
 */
export function getKnownUsersStats(accountId?: string): {
  total: number;
  c2c: number;
  group: number;
  channel: number;
} {
  const users = listKnownUsers({ accountId });

  return {
    c2c: users.filter((u) => u.type === "c2c").length,
    channel: 0,
    group: users.filter((u) => u.type === "group").length,
    total: users.length, // Channel users are not tracked in known-users storage.
  };
}
