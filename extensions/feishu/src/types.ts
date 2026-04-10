import type { BaseProbeResult } from "openclaw/plugin-sdk/core";
import type {
  FeishuAccountConfigSchema,
  FeishuConfigSchema,
  FeishuGroupSchema,
  z,
} from "./config-schema.js";
import type { MentionTarget } from "./mention-target.types.js";

export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;
export type FeishuGroupConfig = z.infer<typeof FeishuGroupSchema>;
export type FeishuAccountConfig = z.infer<typeof FeishuAccountConfigSchema>;

export type FeishuDomain = "feishu" | "lark" | (string & {});
export type FeishuConnectionMode = "websocket" | "webhook";

export type FeishuDefaultAccountSelectionSource =
  | "explicit-default"
  | "mapped-default"
  | "fallback";
export type FeishuAccountSelectionSource = "explicit" | FeishuDefaultAccountSelectionSource;

export interface ResolvedFeishuAccount {
  accountId: string;
  selectionSource: FeishuAccountSelectionSource;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
  /** Merged config (top-level defaults + account-specific overrides) */
  config: FeishuConfig;
}

export type FeishuIdType = "open_id" | "user_id" | "union_id" | "chat_id";

export interface FeishuMessageContext {
  chatId: string;
  messageId: string;
  senderId: string;
  senderOpenId: string;
  senderName?: string;
  chatType: "p2p" | "group" | "private";
  mentionedBot: boolean;
  hasAnyMention?: boolean;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  content: string;
  contentType: string;
  /** Mention forward targets (excluding the bot itself) */
  mentionTargets?: MentionTarget[];
}

export interface FeishuSendResult {
  messageId: string;
  chatId: string;
}

export type FeishuChatType = "p2p" | "group" | "private";

export interface FeishuMessageInfo {
  messageId: string;
  chatId: string;
  chatType?: FeishuChatType;
  senderId?: string;
  senderOpenId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
  /** Feishu thread ID (omt_xxx) — present when the message belongs to a topic thread. */
  threadId?: string;
}

export type FeishuProbeResult = BaseProbeResult<string> & {
  appId?: string;
  botName?: string;
  botOpenId?: string;
};

export interface FeishuMediaInfo {
  path: string;
  contentType?: string;
  placeholder: string;
}

export interface FeishuToolsConfig {
  doc?: boolean;
  chat?: boolean;
  wiki?: boolean;
  drive?: boolean;
  perm?: boolean;
  scopes?: boolean;
}

export interface DynamicAgentCreationConfig {
  enabled?: boolean;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
  maxAgents?: number;
}
