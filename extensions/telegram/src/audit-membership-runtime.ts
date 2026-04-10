import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/text-runtime";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-runtime";
import type {
  AuditTelegramGroupMembershipParams,
  TelegramGroupMembershipAudit,
  TelegramGroupMembershipAuditEntry,
} from "./audit.types.js";
import { resolveTelegramApiBase, resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

interface TelegramApiOk<T> {
  ok: true;
  result: T;
}
interface TelegramApiErr {
  ok: false;
  description?: string;
}
type TelegramGroupMembershipAuditData = Omit<TelegramGroupMembershipAudit, "elapsedMs">;
interface TelegramChatMemberResult {
  status?: string;
}

export async function auditTelegramGroupMembershipImpl(
  params: AuditTelegramGroupMembershipParams,
): Promise<TelegramGroupMembershipAuditData> {
  const proxyFetch = params.proxyUrl ? makeProxyFetch(params.proxyUrl) : undefined;
  const fetcher = resolveTelegramFetch(proxyFetch, {
    network: params.network,
  });
  const apiBase = resolveTelegramApiBase(params.apiRoot);
  const base = `${apiBase}/bot${params.token}`;
  const groups: TelegramGroupMembershipAuditEntry[] = [];

  for (const chatId of params.groupIds) {
    try {
      const url = `${base}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(params.botId))}`;
      const res = await fetchWithTimeout(url, {}, params.timeoutMs, fetcher);
      const json = (await res.json()) as TelegramApiOk<TelegramChatMemberResult> | TelegramApiErr;
      if (!res.ok || !isRecord(json) || !json.ok) {
        const desc =
          isRecord(json) && !json.ok && typeof json.description === "string"
            ? json.description
            : `getChatMember failed (${res.status})`;
        groups.push({
          chatId,
          error: desc,
          matchKey: chatId,
          matchSource: "id",
          ok: false,
          status: null,
        });
        continue;
      }
      const status =
        isRecord(json.result) && typeof json.result.status === "string" ? json.result.status : null;
      const ok = status === "creator" || status === "administrator" || status === "member";
      groups.push({
        chatId,
        error: ok ? null : "bot not in group",
        matchKey: chatId,
        matchSource: "id",
        ok,
        status,
      });
    } catch (error) {
      groups.push({
        chatId,
        error: formatErrorMessage(error),
        matchKey: chatId,
        matchSource: "id",
        ok: false,
        status: null,
      });
    }
  }

  return {
    checkedGroups: groups.length,
    groups,
    hasWildcardUnmentionedGroups: false,
    ok: groups.every((g) => g.ok),
    unresolvedGroups: 0,
  };
}
