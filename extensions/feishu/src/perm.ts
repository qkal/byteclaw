import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { type FeishuPermParams, FeishuPermSchema } from "./perm-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";

type ListTokenType =
  | "doc"
  | "sheet"
  | "file"
  | "wiki"
  | "bitable"
  | "docx"
  | "mindnote"
  | "minutes"
  | "slides";
type CreateTokenType =
  | "doc"
  | "sheet"
  | "file"
  | "wiki"
  | "bitable"
  | "docx"
  | "folder"
  | "mindnote"
  | "minutes"
  | "slides";
type MemberType =
  | "email"
  | "openid"
  | "unionid"
  | "openchat"
  | "opendepartmentid"
  | "userid"
  | "groupid"
  | "wikispaceid";
type PermType = "view" | "edit" | "full_access";

// ============ Actions ============

async function listMembers(client: Lark.Client, token: string, type: string) {
  const res = await client.drive.permissionMember.list({
    params: { type: type as ListTokenType },
    path: { token },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    members:
      res.data?.items?.map((m) => ({
        member_id: m.member_id,
        member_type: m.member_type,
        name: m.name,
        perm: m.perm,
      })) ?? [],
  };
}

async function addMember(
  client: Lark.Client,
  token: string,
  type: string,
  memberType: string,
  memberId: string,
  perm: string,
) {
  const res = await client.drive.permissionMember.create({
    data: {
      member_id: memberId,
      member_type: memberType as MemberType,
      perm: perm as PermType,
    },
    params: { need_notification: false, type: type as CreateTokenType },
    path: { token },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    member: res.data?.member,
    success: true,
  };
}

async function removeMember(
  client: Lark.Client,
  token: string,
  type: string,
  memberType: string,
  memberId: string,
) {
  const res = await client.drive.permissionMember.delete({
    params: { member_type: memberType as MemberType, type: type as CreateTokenType },
    path: { member_id: memberId, token },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
  };
}

// ============ Tool Registration ============

export function registerFeishuPermTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_perm: No config available, skipping perm tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_perm: No Feishu accounts configured, skipping perm tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.perm) {
    api.logger.debug?.("feishu_perm: perm tool disabled in config (default: false)");
    return;
  }

  type FeishuPermExecuteParams = FeishuPermParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        description: "Feishu permission management. Actions: list, add, remove",
        async execute(_toolCallId, params) {
          const p = params as FeishuPermExecuteParams;
          try {
            const client = createFeishuToolClient({
              api,
              defaultAccountId,
              executeParams: p,
            });
            switch (p.action) {
              case "list": {
                return jsonToolResult(await listMembers(client, p.token, p.type));
              }
              case "add": {
                return jsonToolResult(
                  await addMember(client, p.token, p.type, p.member_type, p.member_id, p.perm),
                );
              }
              case "remove": {
                return jsonToolResult(
                  await removeMember(client, p.token, p.type, p.member_type, p.member_id),
                );
              }
              default: {
                return unknownToolActionResult((p as { action?: unknown }).action);
              }
            }
          } catch (error) {
            return toolExecutionErrorResult(error);
          }
        },
        label: "Feishu Perm",
        name: "feishu_perm",
        parameters: FeishuPermSchema,
      };
    },
    { name: "feishu_perm" },
  );

  api.logger.info?.(`feishu_perm: Registered feishu_perm tool`);
}
