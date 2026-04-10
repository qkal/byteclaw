import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createAccountListHelpers,
  normalizeAccountId,
  resolveUserPath,
} from "openclaw/plugin-sdk/account-core";
import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";
import type { WhatsAppAccountConfig } from "./account-types.js";
import { hasWebCredsSync } from "./creds-files.js";

export interface ResolvedWhatsAppAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  sendReadReceipts: boolean;
  messagePrefix?: string;
  defaultTo?: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  selfChatMode?: boolean;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  dmPolicy?: DmPolicy;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  blockStreaming?: boolean;
  ackReaction?: WhatsAppAccountConfig["ackReaction"];
  reactionLevel?: WhatsAppAccountConfig["reactionLevel"];
  groups?: WhatsAppAccountConfig["groups"];
  debounceMs?: number;
}

export const DEFAULT_WHATSAPP_MEDIA_MAX_MB = 50;

const { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId } =
  createAccountListHelpers("whatsapp");
export const listWhatsAppAccountIds = listAccountIds;
export const resolveDefaultWhatsAppAccountId = resolveDefaultAccountId;

export function listWhatsAppAuthDirs(cfg: OpenClawConfig): string[] {
  const oauthDir = resolveOAuthDir();
  const whatsappDir = path.join(oauthDir, "whatsapp");
  const authDirs = new Set<string>([oauthDir, path.join(whatsappDir, DEFAULT_ACCOUNT_ID)]);

  const accountIds = listConfiguredAccountIds(cfg);
  for (const accountId of accountIds) {
    authDirs.add(resolveWhatsAppAuthDir({ accountId, cfg }).authDir);
  }

  try {
    const entries = fs.readdirSync(whatsappDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      authDirs.add(path.join(whatsappDir, entry.name));
    }
  } catch {
    // Ignore missing dirs
  }

  return [...authDirs];
}

export function hasAnyWhatsAppAuth(cfg: OpenClawConfig): boolean {
  return listWhatsAppAuthDirs(cfg).some((authDir) => hasWebCredsSync(authDir));
}

function resolveDefaultAuthDir(accountId: string): string {
  return path.join(resolveOAuthDir(), "whatsapp", normalizeAccountId(accountId));
}

function resolveLegacyAuthDir(): string {
  // Legacy Baileys creds lived in the same directory as OAuth tokens.
  return resolveOAuthDir();
}

function legacyAuthExists(authDir: string): boolean {
  try {
    return fs.existsSync(path.join(authDir, "creds.json"));
  } catch {
    return false;
  }
}

export function resolveWhatsAppAuthDir(params: { cfg: OpenClawConfig; accountId: string }): {
  authDir: string;
  isLegacy: boolean;
} {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveMergedWhatsAppAccountConfig({ accountId, cfg: params.cfg });
  const configured = account?.authDir?.trim();
  if (configured) {
    return { authDir: resolveUserPath(configured), isLegacy: false };
  }

  const defaultDir = resolveDefaultAuthDir(accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const legacyDir = resolveLegacyAuthDir();
    if (legacyAuthExists(legacyDir) && !legacyAuthExists(defaultDir)) {
      return { authDir: legacyDir, isLegacy: true };
    }
  }

  return { authDir: defaultDir, isLegacy: false };
}

export function resolveWhatsAppAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWhatsAppAccount {
  const merged = resolveMergedWhatsAppAccountConfig({
    accountId: params.accountId?.trim() || resolveDefaultWhatsAppAccountId(params.cfg),
    cfg: params.cfg,
  });
  const { accountId } = merged;
  const enabled = merged.enabled !== false;
  const { authDir, isLegacy } = resolveWhatsAppAuthDir({
    accountId,
    cfg: params.cfg,
  });
  return {
    accountId,
    ackReaction: merged.ackReaction,
    allowFrom: merged.allowFrom,
    authDir,
    blockStreaming: merged.blockStreaming,
    chunkMode: merged.chunkMode,
    debounceMs: merged.debounceMs,
    defaultTo: merged.defaultTo,
    dmPolicy: merged.dmPolicy,
    enabled,
    groupAllowFrom: merged.groupAllowFrom,
    groupPolicy: merged.groupPolicy,
    groups: merged.groups,
    isLegacyAuthDir: isLegacy,
    mediaMaxMb: merged.mediaMaxMb,
    messagePrefix: merged.messagePrefix ?? params.cfg.messages?.messagePrefix,
    name: normalizeOptionalString(merged.name),
    reactionLevel: merged.reactionLevel,
    selfChatMode: merged.selfChatMode,
    sendReadReceipts: merged.sendReadReceipts ?? true,
    textChunkLimit: merged.textChunkLimit,
  };
}

export function resolveWhatsAppMediaMaxBytes(
  account: Pick<ResolvedWhatsAppAccount, "mediaMaxMb">,
): number {
  const mediaMaxMb =
    typeof account.mediaMaxMb === "number" && account.mediaMaxMb > 0
      ? account.mediaMaxMb
      : DEFAULT_WHATSAPP_MEDIA_MAX_MB;
  return mediaMaxMb * 1024 * 1024;
}

export function listEnabledWhatsAppAccounts(cfg: OpenClawConfig): ResolvedWhatsAppAccount[] {
  return listWhatsAppAccountIds(cfg)
    .map((accountId) => resolveWhatsAppAccount({ accountId, cfg }))
    .filter((account) => account.enabled);
}
