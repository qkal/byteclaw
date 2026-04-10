import {
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
} from "openclaw/plugin-sdk/directory-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuTarget } from "./targets.js";

export interface FeishuDirectoryPeer {
  kind: "user";
  id: string;
  name?: string;
}

export interface FeishuDirectoryGroup {
  kind: "group";
  id: string;
  name?: string;
}

function toFeishuDirectoryPeers(ids: string[]): FeishuDirectoryPeer[] {
  return ids.map((id) => ({ id, kind: "user" }));
}

function toFeishuDirectoryGroups(ids: string[]): FeishuDirectoryGroup[] {
  return ids.map((id) => ({ id, kind: "group" }));
}

export async function listFeishuDirectoryPeers(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ accountId: params.accountId, cfg: params.cfg });
  const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
    allowFrom: account.config.allowFrom,
    limit: params.limit,
    map: account.config.dms,
    normalizeAllowFromId: (entry) => normalizeFeishuTarget(entry) ?? entry,
    normalizeMapKeyId: (entry) => normalizeFeishuTarget(entry) ?? entry,
    query: params.query,
  });
  return toFeishuDirectoryPeers(entries.map((entry) => entry.id));
}

export async function listFeishuDirectoryGroups(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ accountId: params.accountId, cfg: params.cfg });
  const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
    allowFrom: account.config.groupAllowFrom,
    groups: account.config.groups,
    limit: params.limit,
    query: params.query,
  });
  return toFeishuDirectoryGroups(entries.map((entry) => entry.id));
}
