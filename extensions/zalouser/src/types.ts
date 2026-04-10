import type { Style } from "./zca-constants.js";

export interface ZcaFriend {
  userId: string;
  displayName: string;
  avatar?: string;
}

export interface ZaloGroup {
  groupId: string;
  name: string;
  memberCount?: number;
}

export interface ZaloGroupMember {
  userId: string;
  displayName: string;
  avatar?: string;
}

export interface ZaloEventMessage {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string | number;
}

export interface ZaloInboundMessage {
  threadId: string;
  isGroup: boolean;
  senderId: string;
  senderName?: string;
  groupName?: string;
  content: string;
  commandContent?: string;
  timestampMs: number;
  msgId?: string;
  cliMsgId?: string;
  hasAnyMention?: boolean;
  wasExplicitlyMentioned?: boolean;
  canResolveExplicitMention?: boolean;
  implicitMention?: boolean;
  eventMessage?: ZaloEventMessage;
  raw: unknown;
}

export interface ZcaUserInfo {
  userId: string;
  displayName: string;
  avatar?: string;
}

export interface ZaloSendOptions {
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  textMode?: "markdown" | "plain";
  textChunkMode?: "length" | "newline";
  textChunkLimit?: number;
  textStyles?: Style[];
}

export interface ZaloSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ZaloGroupContext {
  groupId: string;
  name?: string;
  members?: string[];
}

export interface ZaloAuthStatus {
  connected: boolean;
  message: string;
}

export interface ZalouserToolConfig { allow?: string[]; deny?: string[] }

export interface ZalouserGroupConfig {
  enabled?: boolean;
  requireMention?: boolean;
  tools?: ZalouserToolConfig;
}

interface ZalouserSharedConfig {
  enabled?: boolean;
  name?: string;
  profile?: string;
  dangerouslyAllowNameMatching?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: (string | number)[];
  historyLimit?: number;
  groupAllowFrom?: (string | number)[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, ZalouserGroupConfig>;
  messagePrefix?: string;
  responsePrefix?: string;
}

export type ZalouserAccountConfig = ZalouserSharedConfig;

export type ZalouserConfig = ZalouserSharedConfig & {
  defaultAccount?: string;
  accounts?: Record<string, ZalouserAccountConfig>;
};

export interface ResolvedZalouserAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  profile: string;
  authenticated: boolean;
  config: ZalouserAccountConfig;
}
