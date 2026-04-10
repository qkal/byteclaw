import { type Static, Type } from "@sinclair/typebox";

const TokenType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
  Type.Literal("folder"),
  Type.Literal("file"),
  Type.Literal("wiki"),
  Type.Literal("mindnote"),
]);

const MemberType = Type.Union([
  Type.Literal("email"),
  Type.Literal("openid"),
  Type.Literal("userid"),
  Type.Literal("unionid"),
  Type.Literal("openchat"),
  Type.Literal("opendepartmentid"),
]);

const Permission = Type.Union([
  Type.Literal("view"),
  Type.Literal("edit"),
  Type.Literal("full_access"),
]);

export const FeishuPermSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    token: Type.String({ description: "File token" }),
    type: TokenType,
  }),
  Type.Object({
    action: Type.Literal("add"),
    member_id: Type.String({ description: "Member ID (email, open_id, user_id, etc.)" }),
    member_type: MemberType,
    perm: Permission,
    token: Type.String({ description: "File token" }),
    type: TokenType,
  }),
  Type.Object({
    action: Type.Literal("remove"),
    member_id: Type.String({ description: "Member ID to remove" }),
    member_type: MemberType,
    token: Type.String({ description: "File token" }),
    type: TokenType,
  }),
]);

export type FeishuPermParams = Static<typeof FeishuPermSchema>;
