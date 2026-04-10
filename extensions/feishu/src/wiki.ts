import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";
import { type FeishuWikiParams, FeishuWikiSchema } from "./wiki-schema.js";

type ObjType = "doc" | "sheet" | "mindnote" | "bitable" | "file" | "docx" | "slides";

// ============ Actions ============

const WIKI_ACCESS_HINT =
  "To grant wiki access: Open wiki space → Settings → Members → Add the bot. " +
  "See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";

async function listSpaces(client: Lark.Client) {
  const res = await client.wiki.space.list({});
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const spaces =
    res.data?.items?.map((s) => ({
      description: s.description,
      name: s.name,
      space_id: s.space_id,
      visibility: s.visibility,
    })) ?? [];

  return {
    spaces,
    ...(spaces.length === 0 && { hint: WIKI_ACCESS_HINT }),
  };
}

async function listNodes(client: Lark.Client, spaceId: string, parentNodeToken?: string) {
  const res = await client.wiki.spaceNode.list({
    params: { parent_node_token: parentNodeToken },
    path: { space_id: spaceId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    nodes:
      res.data?.items?.map((n) => ({
        has_child: n.has_child,
        node_token: n.node_token,
        obj_token: n.obj_token,
        obj_type: n.obj_type,
        title: n.title,
      })) ?? [],
  };
}

async function getNode(client: Lark.Client, token: string) {
  const res = await client.wiki.space.getNode({
    params: { token },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    create_time: node?.node_create_time,
    creator: node?.creator,
    has_child: node?.has_child,
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    parent_node_token: node?.parent_node_token,
    space_id: node?.space_id,
    title: node?.title,
  };
}

async function createNode(
  client: Lark.Client,
  spaceId: string,
  title: string,
  objType?: string,
  parentNodeToken?: string,
) {
  const res = await client.wiki.spaceNode.create({
    data: {
      node_type: "origin" as const,
      obj_type: (objType as ObjType) || "docx",
      parent_node_token: parentNodeToken,
      title,
    },
    path: { space_id: spaceId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
  };
}

async function moveNode(
  client: Lark.Client,
  spaceId: string,
  nodeToken: string,
  targetSpaceId?: string,
  targetParentToken?: string,
) {
  const res = await client.wiki.spaceNode.move({
    data: {
      target_parent_token: targetParentToken,
      target_space_id: targetSpaceId || spaceId,
    },
    path: { node_token: nodeToken, space_id: spaceId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    node_token: res.data?.node?.node_token,
    success: true,
  };
}

async function renameNode(client: Lark.Client, spaceId: string, nodeToken: string, title: string) {
  const res = await client.wiki.spaceNode.updateTitle({
    data: { title },
    path: { node_token: nodeToken, space_id: spaceId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    node_token: nodeToken,
    success: true,
    title,
  };
}

// ============ Tool Registration ============

export function registerFeishuWikiTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_wiki: No config available, skipping wiki tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_wiki: No Feishu accounts configured, skipping wiki tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.wiki) {
    api.logger.debug?.("feishu_wiki: wiki tool disabled in config");
    return;
  }

  type FeishuWikiExecuteParams = FeishuWikiParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        description:
          "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename",
        async execute(_toolCallId, params) {
          const p = params as FeishuWikiExecuteParams;
          try {
            const client = createFeishuToolClient({
              api,
              defaultAccountId,
              executeParams: p,
            });
            switch (p.action) {
              case "spaces": {
                return jsonToolResult(await listSpaces(client));
              }
              case "nodes": {
                return jsonToolResult(await listNodes(client, p.space_id, p.parent_node_token));
              }
              case "get": {
                return jsonToolResult(await getNode(client, p.token));
              }
              case "search": {
                return jsonToolResult({
                  error:
                    "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token.",
                });
              }
              case "create": {
                return jsonToolResult(
                  await createNode(client, p.space_id, p.title, p.obj_type, p.parent_node_token),
                );
              }
              case "move": {
                return jsonToolResult(
                  await moveNode(
                    client,
                    p.space_id,
                    p.node_token,
                    p.target_space_id,
                    p.target_parent_token,
                  ),
                );
              }
              case "rename": {
                return jsonToolResult(await renameNode(client, p.space_id, p.node_token, p.title));
              }
              default: {
                return unknownToolActionResult((p as { action?: unknown }).action);
              }
            }
          } catch (error) {
            return toolExecutionErrorResult(error);
          }
        },
        label: "Feishu Wiki",
        name: "feishu_wiki",
        parameters: FeishuWikiSchema,
      };
    },
    { name: "feishu_wiki" },
  );

  api.logger.info?.(`feishu_wiki: Registered feishu_wiki tool`);
}
