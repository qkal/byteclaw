import { type Static, Type } from "@sinclair/typebox";

const FileType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
  Type.Literal("folder"),
  Type.Literal("file"),
  Type.Literal("mindnote"),
  Type.Literal("shortcut"),
]);

const CommentFileType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("file"),
  Type.Literal("slides"),
]);

export const FeishuDriveSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    folder_token: Type.Optional(
      Type.String({ description: "Folder token (optional, omit for root directory)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("info"),
    file_token: Type.String({ description: "File or folder token" }),
    type: FileType,
  }),
  Type.Object({
    action: Type.Literal("create_folder"),
    folder_token: Type.Optional(
      Type.String({ description: "Parent folder token (optional, omit for root)" }),
    ),
    name: Type.String({ description: "Folder name" }),
  }),
  Type.Object({
    action: Type.Literal("move"),
    file_token: Type.String({ description: "File token to move" }),
    folder_token: Type.String({ description: "Target folder token" }),
    type: FileType,
  }),
  Type.Object({
    action: Type.Literal("delete"),
    file_token: Type.String({ description: "File token to delete" }),
    type: FileType,
  }),
  Type.Object({
    action: Type.Literal("list_comments"),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(CommentFileType),
    page_size: Type.Optional(Type.Integer({ description: "Page size", maximum: 100, minimum: 1 })),
    page_token: Type.Optional(Type.String({ description: "Comment page token" })),
  }),
  Type.Object({
    action: Type.Literal("list_comment_replies"),
    comment_id: Type.String({ description: "Comment id" }),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(CommentFileType),
    page_size: Type.Optional(Type.Integer({ description: "Page size", maximum: 100, minimum: 1 })),
    page_token: Type.Optional(Type.String({ description: "Reply page token" })),
  }),
  Type.Object({
    action: Type.Literal("add_comment"),
    block_id: Type.Optional(
      Type.String({
        description:
          "Optional docx block id for a local comment. Omit to create a full-document comment.",
      }),
    ),
    content: Type.String({ description: "Comment text content" }),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(
      Type.Union([Type.Literal("doc"), Type.Literal("docx")], {
        description: "Document type. Defaults to docx when omitted.",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("reply_comment"),
    comment_id: Type.String({ description: "Comment id" }),
    content: Type.String({ description: "Reply text content" }),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(CommentFileType),
  }),
]);

export type FeishuDriveParams = Static<typeof FeishuDriveSchema>;
