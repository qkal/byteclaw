/**
 * Twitch status issues collector.
 *
 * Detects and reports configuration issues for Twitch accounts.
 */

import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import { getAccountConfig } from "./config.js";
import { resolveTwitchToken } from "./token.js";
import type { ChannelAccountSnapshot } from "./types.js";
import { isAccountConfigured } from "./utils/twitch.js";

/**
 * Collect status issues for Twitch accounts.
 *
 * Analyzes account snapshots and detects configuration problems,
 * authentication issues, and other potential problems.
 *
 * @param accounts - Array of account snapshots to analyze
 * @param getCfg - Optional function to get full config for additional checks
 * @returns Array of detected status issues
 *
 * @example
 * const issues = collectTwitchStatusIssues(accountSnapshots);
 * if (issues.length > 0) {
 *   console.warn("Twitch configuration issues detected:");
 *   issues.forEach(issue => console.warn(`- ${issue.message}`));
 * }
 */
export function collectTwitchStatusIssues(
  accounts: ChannelAccountSnapshot[],
  getCfg?: () => unknown,
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];

  for (const entry of accounts) {
    const {accountId} = entry;

    if (!accountId) {
      continue;
    }

    let account: ReturnType<typeof getAccountConfig> | null = null;
    let cfg: Parameters<typeof resolveTwitchToken>[0] | undefined;
    if (getCfg) {
      try {
        cfg = getCfg() as {
          channels?: { twitch?: { accounts?: Record<string, unknown> } };
        };
        account = getAccountConfig(cfg, accountId);
      } catch {
        // Ignore config access errors
      }
    }

    if (!entry.configured) {
      issues.push({
        accountId,
        channel: "twitch",
        fix: "Add required fields: username, accessToken, and clientId to your account configuration",
        kind: "config",
        message: "Twitch account is not properly configured",
      });
      continue;
    }

    if (entry.enabled === false) {
      issues.push({
        accountId,
        channel: "twitch",
        fix: "Set enabled: true in your account configuration to enable this account",
        kind: "config",
        message: "Twitch account is disabled",
      });
      continue;
    }

    if (account && account.username && account.accessToken && !account.clientId) {
      issues.push({
        accountId,
        channel: "twitch",
        fix: "Add clientId to your Twitch account configuration (from Twitch Developer Portal)",
        kind: "config",
        message: "Twitch client ID is required",
      });
    }

    const tokenResolution = cfg
      ? resolveTwitchToken(cfg as Parameters<typeof resolveTwitchToken>[0], { accountId })
      : { source: "none", token: "" };
    if (account && isAccountConfigured(account, tokenResolution.token)) {
      if (account.accessToken?.startsWith("oauth:")) {
        issues.push({
          accountId,
          channel: "twitch",
          fix: "The 'oauth:' prefix is optional. You can use just the token value, or keep it as-is (it will be normalized automatically).",
          kind: "config",
          message: "Token contains 'oauth:' prefix (will be stripped)",
        });
      }

      if (account.clientSecret && !account.refreshToken) {
        issues.push({
          accountId,
          channel: "twitch",
          fix: "For automatic token refresh, provide both clientSecret and refreshToken. Otherwise, clientSecret is not needed.",
          kind: "config",
          message: "clientSecret provided without refreshToken",
        });
      }

      if (account.allowFrom && account.allowFrom.length === 0) {
        issues.push({
          accountId,
          channel: "twitch",
          fix: "Either add user IDs to allowFrom, remove the allowFrom field, or use allowedRoles instead.",
          kind: "config",
          message: "allowFrom is configured but empty",
        });
      }

      if (
        account.allowedRoles?.includes("all") &&
        account.allowFrom &&
        account.allowFrom.length > 0
      ) {
        issues.push({
          accountId,
          channel: "twitch",
          fix: "When allowedRoles is 'all', the allowFrom list is not needed. Remove allowFrom or set allowedRoles to specific roles.",
          kind: "intent",
          message: "allowedRoles is set to 'all' but allowFrom is also configured",
        });
      }
    }

    if (entry.lastError) {
      issues.push({
        accountId,
        channel: "twitch",
        fix: "Check your token validity and network connection. Ensure the bot has the required OAuth scopes.",
        kind: "runtime",
        message: `Last error: ${entry.lastError}`,
      });
    }

    if (
      entry.configured &&
      !entry.running &&
      !entry.lastStartAt &&
      !entry.lastInboundAt &&
      !entry.lastOutboundAt
    ) {
      issues.push({
        accountId,
        channel: "twitch",
        fix: "Start the Twitch gateway to begin receiving messages. Check logs for connection errors.",
        kind: "runtime",
        message: "Account has never connected successfully",
      });
    }

    if (entry.running && entry.lastStartAt) {
      const uptime = Date.now() - entry.lastStartAt;
      const daysSinceStart = uptime / (1000 * 60 * 60 * 24);
      if (daysSinceStart > 7) {
        issues.push({
          accountId,
          channel: "twitch",
          fix: "Consider restarting the connection periodically to refresh the connection. Twitch tokens may expire after long periods.",
          kind: "runtime",
          message: `Connection has been running for ${Math.floor(daysSinceStart)} days`,
        });
      }
    }
  }

  return issues;
}
