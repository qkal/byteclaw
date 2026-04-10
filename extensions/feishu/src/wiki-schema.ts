import { type Static, Type } from "@sinclair/typebox";

export const FeishuWikiSchema = Type.Union([
  Type.Object({
    action: Type.Literal("spaces"),
  }),
  Type.Object({
    action: Type.Literal("nodes"),
    parent_node_token: Type.Optional(
      Type.String({ description: "Parent node token (optional, omit for root)" }),
    ),
    space_id: Type.String({ description: "Knowledge space ID" }),
  }),
  Type.Object({
    action: Type.Literal("get"),
    token: Type.String({ description: "Wiki node token (from URL /wiki/XXX)" }),
  }),
  Type.Object({
    action: Type.Literal("search"),
    query: Type.String({ description: "Search query" }),
    space_id: Type.Optional(Type.String({ description: "Limit search to this space (optional)" })),
  }),
  Type.Object({
    action: Type.Literal("create"),
    obj_type: Type.Optional(
      Type.Union([Type.Literal("docx"), Type.Literal("sheet"), Type.Literal("bitable")], {
        description: "Object type (default: docx)",
      }),
    ),
    parent_node_token: Type.Optional(
      Type.String({ description: "Parent node token (optional, omit for root)" }),
    ),
    space_id: Type.String({ description: "Knowledge space ID" }),
    title: Type.String({ description: "Node title" }),
  }),
  Type.Object({
    action: Type.Literal("move"),
    node_token: Type.String({ description: "Node token to move" }),
    space_id: Type.String({ description: "Source knowledge space ID" }),
    target_parent_token: Type.Optional(
      Type.String({ description: "Target parent node token (optional, root if omitted)" }),
    ),
    target_space_id: Type.Optional(
      Type.String({ description: "Target space ID (optional, same space if omitted)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("rename"),
    node_token: Type.String({ description: "Node token to rename" }),
    space_id: Type.String({ description: "Knowledge space ID" }),
    title: Type.String({ description: "New title" }),
  }),
]);

export type FeishuWikiParams = Static<typeof FeishuWikiSchema>;
