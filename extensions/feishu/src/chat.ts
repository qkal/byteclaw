import type * as Lark from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { type FeishuChatParams, FeishuChatSchema } from "./chat-schema.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ text: JSON.stringify(data, null, 2), type: "text" as const }],
    details: data,
  };
}

export async function getChatInfo(client: Lark.Client, chatId: string) {
  const res = await client.im.chat.get({ path: { chat_id: chatId } });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const chat = res.data;
  return {
    avatar: chat?.avatar,
    chat_id: chatId,
    chat_mode: chat?.chat_mode,
    chat_type: chat?.chat_type,
    description: chat?.description,
    join_message_visibility: chat?.join_message_visibility,
    leave_message_visibility: chat?.leave_message_visibility,
    membership_approval: chat?.membership_approval,
    moderation_permission: chat?.moderation_permission,
    name: chat?.name,
    owner_id: chat?.owner_id,
    tenant_key: chat?.tenant_key,
    user_count: chat?.user_count,
  };
}

export async function getChatMembers(
  client: Lark.Client,
  chatId: string,
  pageSize?: number,
  pageToken?: string,
  memberIdType?: "open_id" | "user_id" | "union_id",
) {
  const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
  const res = await client.im.chatMembers.get({
    params: {
      member_id_type: memberIdType ?? "open_id",
      page_size,
      page_token: pageToken,
    },
    path: { chat_id: chatId },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    chat_id: chatId,
    has_more: res.data?.has_more,
    members:
      res.data?.items?.map((item) => ({
        member_id: item.member_id,
        member_id_type: item.member_id_type,
        name: item.name,
        tenant_key: item.tenant_key,
      })) ?? [],
    page_token: res.data?.page_token,
  };
}

export async function getFeishuMemberInfo(
  client: Lark.Client,
  memberId: string,
  memberIdType: "open_id" | "user_id" | "union_id" = "open_id",
) {
  const res = await client.contact.user.get({
    params: {
      department_id_type: "open_department_id",
      user_id_type: memberIdType,
    },
    path: { user_id: memberId },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const user = res.data?.user;
  return {
    avatar: user?.avatar,
    city: user?.city,
    country: user?.country,
    department_ids: user?.department_ids,
    department_path: user?.department_path,
    description: user?.description,
    email: user?.email,
    employee_no: user?.employee_no,
    employee_type: user?.employee_type,
    en_name: user?.en_name,
    enterprise_email: user?.enterprise_email,
    geo: user?.geo,
    is_tenant_manager: user?.is_tenant_manager,
    job_title: user?.job_title,
    join_time: user?.join_time,
    leader_user_id: user?.leader_user_id,
    member_id: memberId,
    member_id_type: memberIdType,
    mobile: user?.mobile,
    mobile_visible: user?.mobile_visible,
    name: user?.name,
    nickname: user?.nickname,
    open_id: user?.open_id,
    status: user?.status,
    union_id: user?.union_id,
    user_id: user?.user_id,
    work_station: user?.work_station,
  };
}

export function registerFeishuChatTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_chat: No config available, skipping chat tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_chat: No Feishu accounts configured, skipping chat tools");
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.chat) {
    api.logger.debug?.("feishu_chat: chat tool disabled in config");
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      description: "Feishu chat operations. Actions: members, info, member_info",
      async execute(_toolCallId, params) {
        const p = params as FeishuChatParams;
        try {
          const client = getClient();
          switch (p.action) {
            case "members": {
              if (!p.chat_id) {
                return json({ error: "chat_id is required for action members" });
              }
              return json(
                await getChatMembers(
                  client,
                  p.chat_id,
                  p.page_size,
                  p.page_token,
                  p.member_id_type,
                ),
              );
            }
            case "info": {
              if (!p.chat_id) {
                return json({ error: "chat_id is required for action info" });
              }
              return json(await getChatInfo(client, p.chat_id));
            }
            case "member_info": {
              if (!p.member_id) {
                return json({ error: "member_id is required for action member_info" });
              }
              return json(
                await getFeishuMemberInfo(client, p.member_id, p.member_id_type ?? "open_id"),
              );
            }
            default: {
              return json({ error: `Unknown action: ${String(p.action)}` });
            }
          }
        } catch (error) {
          return json({ error: formatErrorMessage(error) });
        }
      },
      label: "Feishu Chat",
      name: "feishu_chat",
      parameters: FeishuChatSchema,
    },
    { name: "feishu_chat" },
  );

  api.logger.info?.("feishu_chat: Registered feishu_chat tool");
}
