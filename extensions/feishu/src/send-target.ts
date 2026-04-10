import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

interface FeishuSendTarget {
  client: ReturnType<typeof createFeishuClient>;
  receiveId: string;
  receiveIdType: ReturnType<typeof resolveReceiveIdType>;
}

export function resolveFeishuSendTarget(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
}): FeishuSendTarget {
  const target = params.to.trim();
  const account = resolveFeishuRuntimeAccount({ accountId: params.accountId, cfg: params.cfg });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(target);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${params.to}`);
  }
  // Preserve explicit routing prefixes (chat/group/user/dm/open_id) when present.
  // NormalizeFeishuTarget strips these prefixes, so infer type from the raw target first.
  const withoutProviderPrefix = target.replace(/^(feishu|lark):/i, "");
  return {
    client,
    receiveId,
    receiveIdType: resolveReceiveIdType(withoutProviderPrefix),
  };
}
