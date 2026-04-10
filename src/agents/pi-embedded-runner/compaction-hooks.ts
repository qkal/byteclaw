import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { log } from "./logger.js";

function resolvePostCompactionIndexSyncMode(config?: OpenClawConfig): "off" | "async" | "await" {
  const mode = config?.agents?.defaults?.compaction?.postIndexSync;
  if (mode === "off" || mode === "async" || mode === "await") {
    return mode;
  }
  return "async";
}

async function runPostCompactionSessionMemorySync(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
}): Promise<void> {
  if (!params.config) {
    return;
  }
  try {
    const sessionFile = params.sessionFile.trim();
    if (!sessionFile) {
      return;
    }
    const agentId = resolveSessionAgentId({
      config: params.config,
      sessionKey: params.sessionKey,
    });
    const resolvedMemory = resolveMemorySearchConfig(params.config, agentId);
    if (!resolvedMemory || !resolvedMemory.sources.includes("sessions")) {
      return;
    }
    if (!resolvedMemory.sync.sessions.postCompactionForce) {
      return;
    }
    const { manager } = await getActiveMemorySearchManager({
      agentId,
      cfg: params.config,
    });
    if (!manager?.sync) {
      return;
    }
    await manager.sync({
      reason: "post-compaction",
      sessionFiles: [sessionFile],
    });
  } catch (error) {
    log.warn(`memory sync skipped (post-compaction): ${formatErrorMessage(error)}`);
  }
}

function syncPostCompactionSessionMemory(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
  mode: "off" | "async" | "await";
}): Promise<void> {
  if (params.mode === "off" || !params.config) {
    return Promise.resolve();
  }

  const syncTask = runPostCompactionSessionMemorySync({
    config: params.config,
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
  });
  if (params.mode === "await") {
    return syncTask;
  }
  void syncTask;
  return Promise.resolve();
}

export async function runPostCompactionSideEffects(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
}): Promise<void> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return;
  }
  emitSessionTranscriptUpdate(sessionFile);
  await syncPostCompactionSessionMemory({
    config: params.config,
    mode: resolvePostCompactionIndexSyncMode(params.config),
    sessionFile,
    sessionKey: params.sessionKey,
  });
}

export interface CompactionHookRunner {
  hasHooks?: (hookName?: string) => boolean;
  runBeforeCompaction?: (
    metrics: { messageCount: number; tokenCount?: number; sessionFile?: string },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
  runAfterCompaction?: (
    metrics: {
      messageCount: number;
      tokenCount?: number;
      compactedCount: number;
      sessionFile: string;
    },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
}

export function asCompactionHookRunner(
  hookRunner: ReturnType<typeof getGlobalHookRunner> | null | undefined,
): CompactionHookRunner | null {
  if (!hookRunner) {
    return null;
  }
  return {
    hasHooks: (hookName?: string) => hookRunner.hasHooks?.(hookName as never) ?? false,
    runAfterCompaction: hookRunner.runAfterCompaction?.bind(hookRunner),
    runBeforeCompaction: hookRunner.runBeforeCompaction?.bind(hookRunner),
  };
}

function estimateTokenCountSafe(
  messages: AgentMessage[],
  estimateTokensFn: (message: AgentMessage) => number,
): number | undefined {
  try {
    let total = 0;
    for (const message of messages) {
      total += estimateTokensFn(message);
    }
    return total;
  } catch {
    return undefined;
  }
}

export function buildBeforeCompactionHookMetrics(params: {
  originalMessages: AgentMessage[];
  currentMessages: AgentMessage[];
  observedTokenCount?: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  return {
    messageCountBefore: params.currentMessages.length,
    messageCountOriginal: params.originalMessages.length,
    tokenCountBefore:
      params.observedTokenCount ??
      estimateTokenCountSafe(params.currentMessages, params.estimateTokensFn),
    tokenCountOriginal: estimateTokenCountSafe(params.originalMessages, params.estimateTokensFn),
  };
}

export async function runBeforeCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionKey?: string;
  sessionAgentId: string;
  workspaceDir: string;
  messageProvider?: string;
  metrics: ReturnType<typeof buildBeforeCompactionHookMetrics>;
}) {
  const missingSessionKey = !params.sessionKey || !params.sessionKey.trim();
  const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
  try {
    const hookEvent = createInternalHookEvent("session", "compact:before", hookSessionKey, {
      messageCount: params.metrics.messageCountBefore,
      messageCountOriginal: params.metrics.messageCountOriginal,
      missingSessionKey,
      sessionId: params.sessionId,
      tokenCount: params.metrics.tokenCountBefore,
      tokenCountOriginal: params.metrics.tokenCountOriginal,
    });
    await triggerInternalHook(hookEvent);
  } catch (error) {
    log.warn("session:compact:before hook failed", {
      errorMessage: formatErrorMessage(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
  }
  if (params.hookRunner?.hasHooks?.("before_compaction")) {
    try {
      await params.hookRunner.runBeforeCompaction?.(
        {
          messageCount: params.metrics.messageCountBefore,
          tokenCount: params.metrics.tokenCountBefore,
        },
        {
          agentId: params.sessionAgentId,
          messageProvider: params.messageProvider,
          sessionId: params.sessionId,
          sessionKey: hookSessionKey,
          workspaceDir: params.workspaceDir,
        },
      );
    } catch (error) {
      log.warn("before_compaction hook failed", {
        errorMessage: formatErrorMessage(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
  return {
    hookSessionKey,
    missingSessionKey,
  };
}

export function estimateTokensAfterCompaction(params: {
  messagesAfter: AgentMessage[];
  observedTokenCount?: number;
  fullSessionTokensBefore: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  const tokensAfter = estimateTokenCountSafe(params.messagesAfter, params.estimateTokensFn);
  if (tokensAfter === undefined) {
    return undefined;
  }
  const sanityCheckBaseline = params.observedTokenCount ?? params.fullSessionTokensBefore;
  if (
    sanityCheckBaseline > 0 &&
    tokensAfter >
      (params.observedTokenCount !== undefined ? sanityCheckBaseline : sanityCheckBaseline * 1.1)
  ) {
    return undefined;
  }
  return tokensAfter;
}

export async function runAfterCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionAgentId: string;
  hookSessionKey: string;
  missingSessionKey: boolean;
  workspaceDir: string;
  messageProvider?: string;
  messageCountAfter: number;
  tokensAfter?: number;
  compactedCount: number;
  sessionFile: string;
  summaryLength?: number;
  tokensBefore?: number;
  firstKeptEntryId?: string;
}) {
  try {
    const hookEvent = createInternalHookEvent("session", "compact:after", params.hookSessionKey, {
      compactedCount: params.compactedCount,
      firstKeptEntryId: params.firstKeptEntryId,
      messageCount: params.messageCountAfter,
      missingSessionKey: params.missingSessionKey,
      sessionId: params.sessionId,
      summaryLength: params.summaryLength,
      tokenCount: params.tokensAfter,
      tokensAfter: params.tokensAfter,
      tokensBefore: params.tokensBefore,
    });
    await triggerInternalHook(hookEvent);
  } catch (error) {
    log.warn("session:compact:after hook failed", {
      errorMessage: formatErrorMessage(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
  }
  if (params.hookRunner?.hasHooks?.("after_compaction")) {
    try {
      await params.hookRunner.runAfterCompaction?.(
        {
          compactedCount: params.compactedCount,
          messageCount: params.messageCountAfter,
          sessionFile: params.sessionFile,
          tokenCount: params.tokensAfter,
        },
        {
          agentId: params.sessionAgentId,
          messageProvider: params.messageProvider,
          sessionId: params.sessionId,
          sessionKey: params.hookSessionKey,
          workspaceDir: params.workspaceDir,
        },
      );
    } catch (error) {
      log.warn("after_compaction hook failed", {
        errorMessage: formatErrorMessage(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
