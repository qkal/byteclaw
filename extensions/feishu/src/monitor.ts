import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { listEnabledFeishuAccounts, resolveFeishuRuntimeAccount } from "./accounts.js";
import {
  type FeishuReactionCreatedEvent,
  monitorSingleAccount,
  resolveReactionSyntheticEvent,
} from "./monitor.account.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  stopFeishuMonitorState,
} from "./monitor.state.js";

export interface MonitorFeishuOpts {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
}

export {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  resolveReactionSyntheticEvent,
};
export type { FeishuReactionCreatedEvent };

export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  if (opts.accountId) {
    const account = resolveFeishuRuntimeAccount(
      { accountId: opts.accountId, cfg },
      { requireEventSecrets: true },
    );
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      abortSignal: opts.abortSignal,
      account,
      cfg,
      runtime: opts.runtime,
    });
  }

  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  const monitorPromises: Promise<void>[] = [];
  for (const account of accounts) {
    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }

    // Probe sequentially so large multi-account startups do not burst Feishu's bot-info endpoint.
    const { botOpenId, botName } = await fetchBotIdentityForMonitor(account, {
      abortSignal: opts.abortSignal,
      runtime: opts.runtime,
    });

    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }

    monitorPromises.push(
      monitorSingleAccount({
        abortSignal: opts.abortSignal,
        account,
        botOpenIdSource: { botName, botOpenId, kind: "prefetched" },
        cfg,
        runtime: opts.runtime,
      }),
    );
  }

  await Promise.all(monitorPromises);
}

export function stopFeishuMonitor(accountId?: string): void {
  stopFeishuMonitorState(accountId);
}
