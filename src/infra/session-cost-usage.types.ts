import type { NormalizedUsage } from "../agents/usage.js";
import type {
  SessionUsageTimePoint as SharedSessionUsageTimePoint,
  SessionUsageTimeSeries as SharedSessionUsageTimeSeries,
} from "../shared/session-usage-timeseries-types.js";

export interface CostBreakdown {
  total?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ParsedUsageEntry {
  usage: NormalizedUsage;
  costTotal?: number;
  costBreakdown?: CostBreakdown;
  provider?: string;
  model?: string;
  timestamp?: Date;
}

export interface ParsedTranscriptEntry {
  message: Record<string, unknown>;
  role?: "user" | "assistant";
  timestamp?: Date;
  durationMs?: number;
  usage?: NormalizedUsage;
  costTotal?: number;
  costBreakdown?: CostBreakdown;
  provider?: string;
  model?: string;
  stopReason?: string;
  toolNames: string[];
  toolResultCounts: { total: number; errors: number };
}

export interface CostUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  // Cost breakdown by token type (from actual API data when available)
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
}

export type CostUsageDailyEntry = CostUsageTotals & {
  date: string;
};

export interface CostUsageSummary {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: CostUsageTotals;
}

export interface SessionDailyUsage {
  date: string; // YYYY-MM-DD
  tokens: number;
  cost: number;
}

export interface SessionDailyMessageCounts {
  date: string; // YYYY-MM-DD
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
}

export interface SessionLatencyStats {
  count: number;
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export type SessionDailyLatency = SessionLatencyStats & {
  date: string; // YYYY-MM-DD
};

export interface SessionDailyModelUsage {
  date: string; // YYYY-MM-DD
  provider?: string;
  model?: string;
  tokens: number;
  cost: number;
  count: number;
}

export interface SessionMessageCounts {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
}

export interface SessionToolUsage {
  totalCalls: number;
  uniqueTools: number;
  tools: { name: string; count: number }[];
}

export interface SessionModelUsage {
  provider?: string;
  model?: string;
  count: number;
  totals: CostUsageTotals;
}

export type SessionCostSummary = CostUsageTotals & {
  sessionId?: string;
  sessionFile?: string;
  firstActivity?: number;
  lastActivity?: number;
  durationMs?: number;
  activityDates?: string[]; // YYYY-MM-DD dates when session had activity
  dailyBreakdown?: SessionDailyUsage[]; // Per-day token/cost breakdown
  dailyMessageCounts?: SessionDailyMessageCounts[];
  dailyLatency?: SessionDailyLatency[];
  dailyModelUsage?: SessionDailyModelUsage[];
  messageCounts?: SessionMessageCounts;
  toolUsage?: SessionToolUsage;
  modelUsage?: SessionModelUsage[];
  latency?: SessionLatencyStats;
};

export interface DiscoveredSession {
  sessionId: string;
  sessionFile: string;
  mtime: number;
  firstUserMessage?: string;
}

export type SessionUsageTimePoint = SharedSessionUsageTimePoint;

export type SessionUsageTimeSeries = SharedSessionUsageTimeSeries;

export interface SessionLogEntry {
  timestamp: number;
  role: "user" | "assistant" | "tool" | "toolResult";
  content: string;
  tokens?: number;
  cost?: number;
}
