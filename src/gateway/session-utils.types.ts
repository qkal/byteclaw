import type { ChatType } from "../channels/chat-type.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionCompactionCheckpoint } from "../config/sessions.js";
import type {
  SessionsListResultBase,
  SessionsPatchResultBase,
  GatewayAgentRow as SharedGatewayAgentRow,
} from "../shared/session-types.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

export interface GatewaySessionsDefaults {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
}

export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";

export interface GatewaySessionRow {
  key: string;
  spawnedBy?: string;
  spawnedWorkspaceDir?: string;
  forkedFromParent?: boolean;
  spawnDepth?: number;
  subagentRole?: SessionEntry["subagentRole"];
  subagentControlScope?: SessionEntry["subagentControlScope"];
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: ChatType;
  origin?: SessionEntry["origin"];
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  parentSessionKey?: string;
  childSessions?: string[];
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: SessionEntry["lastThreadId"];
  compactionCheckpointCount?: number;
  latestCompactionCheckpoint?: SessionCompactionCheckpoint;
}

export type GatewayAgentRow = SharedGatewayAgentRow;

export interface SessionPreviewItem {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
}

export interface SessionsPreviewEntry {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
}

export interface SessionsPreviewResult {
  ts: number;
  previews: SessionsPreviewEntry[];
}

export type SessionsListResult = SessionsListResultBase<GatewaySessionsDefaults, GatewaySessionRow>;

export type SessionsPatchResult = SessionsPatchResultBase<SessionEntry> & {
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};
