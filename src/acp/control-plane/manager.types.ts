import type { OpenClawConfig } from "../../config/config.js";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
  SessionEntry,
} from "../../config/sessions/types.js";
import type { AcpRuntimeError } from "../runtime/errors.js";
import { getAcpRuntimeBackend, requireAcpRuntimeBackend } from "../runtime/registry.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
} from "../runtime/session-meta.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimePromptMode,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
} from "../runtime/types.js";

export type AcpSessionResolution =
  | {
      kind: "none";
      sessionKey: string;
    }
  | {
      kind: "stale";
      sessionKey: string;
      error: AcpRuntimeError;
    }
  | {
      kind: "ready";
      sessionKey: string;
      meta: SessionAcpMeta;
    };

export interface AcpInitializeSessionInput {
  cfg: OpenClawConfig;
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  cwd?: string;
  backendId?: string;
}

export interface AcpTurnAttachment {
  mediaType: string;
  data: string;
}

export interface AcpRunTurnInput {
  cfg: OpenClawConfig;
  sessionKey: string;
  text: string;
  attachments?: AcpTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  signal?: AbortSignal;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
}

export interface AcpCloseSessionInput {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: string;
  discardPersistentState?: boolean;
  clearMeta?: boolean;
  allowBackendUnavailable?: boolean;
  requireAcpSession?: boolean;
}

export interface AcpCloseSessionResult {
  runtimeClosed: boolean;
  runtimeNotice?: string;
  metaCleared: boolean;
}

export interface AcpSessionStatus {
  sessionKey: string;
  backend: string;
  agent: string;
  identity?: SessionAcpIdentity;
  state: SessionAcpMeta["state"];
  mode: AcpRuntimeSessionMode;
  runtimeOptions: AcpSessionRuntimeOptions;
  capabilities: AcpRuntimeCapabilities;
  runtimeStatus?: AcpRuntimeStatus;
  lastActivityAt: number;
  lastError?: string;
}

export interface AcpManagerObservabilitySnapshot {
  runtimeCache: {
    activeSessions: number;
    idleTtlMs: number;
    evictedTotal: number;
    lastEvictedAt?: number;
  };
  turns: {
    active: number;
    queueDepth: number;
    completed: number;
    failed: number;
    averageLatencyMs: number;
    maxLatencyMs: number;
  };
  errorsByCode: Record<string, number>;
}

export interface AcpStartupIdentityReconcileResult {
  checked: number;
  resolved: number;
  failed: number;
}

export interface ActiveTurnState {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  abortController: AbortController;
  cancelPromise?: Promise<void>;
}

export interface TurnLatencyStats {
  completed: number;
  failed: number;
  totalMs: number;
  maxMs: number;
}

export interface AcpSessionManagerDeps {
  listAcpSessions: typeof listAcpSessionEntries;
  readSessionEntry: typeof readAcpSessionEntry;
  upsertSessionMeta: typeof upsertAcpSessionMeta;
  getRuntimeBackend: typeof getAcpRuntimeBackend;
  requireRuntimeBackend: typeof requireAcpRuntimeBackend;
}

export const DEFAULT_DEPS: AcpSessionManagerDeps = {
  getRuntimeBackend: getAcpRuntimeBackend,
  listAcpSessions: listAcpSessionEntries,
  readSessionEntry: readAcpSessionEntry,
  requireRuntimeBackend: requireAcpRuntimeBackend,
  upsertSessionMeta: upsertAcpSessionMeta,
};

export type { AcpSessionRuntimeOptions, SessionAcpMeta, SessionEntry };
