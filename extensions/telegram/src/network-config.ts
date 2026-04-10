import process from "node:process";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-runtime";
import { isTruthyEnvValue, isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

export const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV =
  "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
export const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";
export const TELEGRAM_DNS_RESULT_ORDER_ENV = "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER";

export interface TelegramAutoSelectFamilyDecision {
  value: boolean | null;
  source?: string;
}

let wsl2SyncCache: boolean | undefined;

function isWSL2SyncCached(): boolean {
  if (typeof wsl2SyncCache === "boolean") {
    return wsl2SyncCache;
  }
  wsl2SyncCache = isWSL2Sync();
  return wsl2SyncCache;
}

export interface TelegramDnsResultOrderDecision {
  value: string | null;
  source?: string;
}

export function resolveTelegramAutoSelectFamilyDecision(params?: {
  network?: TelegramNetworkConfig;
  env?: NodeJS.ProcessEnv;
  nodeMajor?: number;
}): TelegramAutoSelectFamilyDecision {
  const env = params?.env ?? process.env;
  const nodeMajor =
    typeof params?.nodeMajor === "number"
      ? params.nodeMajor
      : Number(process.versions.node.split(".")[0]);

  if (isTruthyEnvValue(env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}`, value: true };
  }
  if (isTruthyEnvValue(env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}`, value: false };
  }
  if (typeof params?.network?.autoSelectFamily === "boolean") {
    return { source: "config", value: params.network.autoSelectFamily };
  }
  // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to use IPv4 directly
  if (isWSL2SyncCached()) {
    return { source: "default-wsl2", value: false };
  }
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) {
    return { source: "default-node22", value: true };
  }
  return { value: null };
}

/**
 * Resolve DNS result order setting for Telegram network requests.
 * Some networks/ISPs have issues with IPv6 causing fetch failures.
 * Setting "ipv4first" prioritizes IPv4 addresses in DNS resolution.
 *
 * Priority:
 * 1. Environment variable OPENCLAW_TELEGRAM_DNS_RESULT_ORDER
 * 2. Config: channels.telegram.network.dnsResultOrder
 * 3. Default: "ipv4first" on Node 22+ (to work around common IPv6 issues)
 */
export function resolveTelegramDnsResultOrderDecision(params?: {
  network?: TelegramNetworkConfig;
  env?: NodeJS.ProcessEnv;
  nodeMajor?: number;
}): TelegramDnsResultOrderDecision {
  const env = params?.env ?? process.env;
  const nodeMajor =
    typeof params?.nodeMajor === "number"
      ? params.nodeMajor
      : Number(process.versions.node.split(".")[0]);

  // Check environment variable
  const envValue = normalizeOptionalLowercaseString(env[TELEGRAM_DNS_RESULT_ORDER_ENV]);
  if (envValue === "ipv4first" || envValue === "verbatim") {
    return { source: `env:${TELEGRAM_DNS_RESULT_ORDER_ENV}`, value: envValue };
  }

  // Check config
  const configValue = normalizeOptionalLowercaseString(
    (params?.network as { dnsResultOrder?: string } | undefined)?.dnsResultOrder,
  );
  if (configValue === "ipv4first" || configValue === "verbatim") {
    return { source: "config", value: configValue };
  }

  // Default to ipv4first on Node 22+ to avoid IPv6 issues
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) {
    return { source: "default-node22", value: "ipv4first" };
  }

  return { value: null };
}

export function resetTelegramNetworkConfigStateForTests(): void {
  wsl2SyncCache = undefined;
}
