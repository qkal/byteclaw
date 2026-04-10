import fs from "node:fs/promises";
import readline from "node:readline";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import {
  SILENT_REPLY_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../../auto-reply/tokens.js";
import type { loadConfig } from "../../config/config.js";
import { type SessionEntry, mergeSessionEntry, updateSessionStore } from "../../config/sessions.js";
import { resolveSessionTranscriptFile } from "../../config/sessions/transcript.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import type { resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import { runCliAgent } from "../cli-runner.js";
import { clearCliSession, getCliSessionBinding, setCliSessionBinding } from "../cli-session.js";
import { FailoverError } from "../failover-error.js";
import { formatAgentInternalEventsForPrompt } from "../internal-events.js";
import { hasInternalRuntimeContext } from "../internal-runtime-context.js";
import { isCliProvider } from "../model-selection.js";
import { prepareSessionManagerForRun } from "../pi-embedded-runner/session-manager-init.js";
import { runEmbeddedPiAgent } from "../pi-embedded.js";
import type { buildWorkspaceSkillSnapshot } from "../skills.js";
import type { resolveAgentRunContext } from "./run-context.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

/** Maximum number of JSONL records to inspect before giving up. */
const SESSION_FILE_MAX_RECORDS = 500;

/**
 * Check whether a session transcript file exists and contains at least one
 * assistant message, indicating that the SessionManager has flushed the
 * initial user+assistant exchange to disk.  This is used to decide whether
 * a fallback retry can rely on the on-disk history or must re-send the
 * original prompt.
 *
 * The check parses JSONL records line-by-line (CWE-703) instead of relying
 * on a raw substring match against a bounded byte prefix, which could
 * produce false negatives when the pre-assistant content exceeds the byte
 * limit.
 */
export async function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean> {
  if (!sessionFile) {
    return false;
  }
  try {
    // Guard against symlink-following (CWE-400 / arbitrary-file-read vector).
    const stat = await fs.lstat(sessionFile);
    if (stat.isSymbolicLink()) {
      return false;
    }

    const fh = await fs.open(sessionFile, "r");
    try {
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf8" }) });
      let recordCount = 0;
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        recordCount++;
        if (recordCount > SESSION_FILE_MAX_RECORDS) {
          break;
        }
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = obj as Record<string, unknown> | null;
        if (
          rec?.type === "message" &&
          (rec.message as Record<string, unknown> | undefined)?.role === "assistant"
        ) {
          return true;
        }
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export interface PersistSessionEntryParams {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  clearedFields?: string[];
}

export async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  const persisted = await updateSessionStore(params.storePath, (store) => {
    const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
    for (const field of params.clearedFields ?? []) {
      if (!Object.hasOwn(params.entry, field)) {
        Reflect.deleteProperty(merged, field);
      }
    }
    store[params.sessionKey] = merged;
    return merged;
  });
  params.sessionStore[params.sessionKey] = persisted;
}

export function resolveFallbackRetryPrompt(params: {
  body: string;
  isFallbackRetry: boolean;
  sessionHasHistory?: boolean;
}): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  // When the session has no persisted history (e.g. a freshly-spawned subagent
  // Whose first attempt failed before the SessionManager flushed the user
  // Message to disk), the fallback model would receive only the generic
  // Recovery prompt and lose the original task entirely.  Preserve the
  // Original body in that case so the fallback model can execute the task.
  if (!params.sessionHasHistory) {
    return params.body;
  }
  return "Continue where you left off. The previous model attempt failed or timed out.";
}

export function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (hasInternalRuntimeContext(body)) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

export function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  let rawVisibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { rawText: string; delta: string } => {
    if (!base) {
      return { delta: chunk, rawText: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { delta, rawText: chunk };
    }
    return {
      delta: chunk,
      rawText: `${base}${chunk}`,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        // Strip leading NO_REPLY token when it is glued to visible text
        // (e.g. "NO_REPLYThe user is saying...") so the token never leaks.
        if (startsWithSilentToken(trimmedLeadCandidate, SILENT_REPLY_TOKEN)) {
          const stripped = stripLeadingSilentToken(leadCandidate, SILENT_REPLY_TOKEN);
          if (stripped) {
            pendingSilentPrefix = "";
            rawVisibleText = leadCandidate;
            visibleText = stripped;
            return { delta: stripped, text: stripped };
          }
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          rawVisibleText = leadCandidate;
          visibleText = leadCandidate;
          return {
            delta: leadCandidate,
            text: visibleText,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(rawVisibleText, chunk);
      rawVisibleText = nextVisible.rawText;
      if (!nextVisible.delta) {
        return null;
      }
      visibleText = `${visibleText}${nextVisible.delta}`;
      return { delta: nextVisible.delta, text: visibleText };
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}

const ACP_TRANSCRIPT_USAGE = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: 0,
  },
  input: 0,
  output: 0,
  totalTokens: 0,
} as const;

export async function persistAcpTurnTranscript(params: {
  body: string;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
}): Promise<SessionEntry | undefined> {
  const promptText = params.body;
  const replyText = params.finalText;
  if (!promptText && !replyText) {
    return params.sessionEntry;
  }

  const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
    agentId: params.sessionAgentId,
    sessionEntry: params.sessionEntry,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    threadId: params.threadId,
  });
  const hadSessionFile = await fs
    .access(sessionFile)
    .then(() => true)
    .catch(() => false);
  const sessionManager = SessionManager.open(sessionFile);
  await prepareSessionManagerForRun({
    cwd: params.sessionCwd,
    hadSessionFile,
    sessionFile,
    sessionId: params.sessionId,
    sessionManager,
  });

  if (promptText) {
    sessionManager.appendMessage({
      content: promptText,
      role: "user",
      timestamp: Date.now(),
    });
  }

  if (replyText) {
    sessionManager.appendMessage({
      api: "openai-responses",
      content: [{ text: replyText, type: "text" }],
      model: "acp-runtime",
      provider: "openclaw",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: ACP_TRANSCRIPT_USAGE,
    });
  }

  emitSessionTranscriptUpdate(sessionFile);
  return sessionEntry;
}

export function runAgentAttempt(params: {
  providerOverride: string;
  modelOverride: string;
  cfg: ReturnType<typeof loadConfig>;
  sessionEntry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  body: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  timeoutMs: number;
  runId: string;
  opts: AgentCommandOpts & { senderIsOwner: boolean };
  runContext: ReturnType<typeof resolveAgentRunContext>;
  spawnedBy: string | undefined;
  messageChannel: ReturnType<typeof resolveMessageChannel>;
  skillsSnapshot: ReturnType<typeof buildWorkspaceSkillSnapshot> | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  agentDir: string;
  onAgentEvent: (evt: { stream: string; data?: Record<string, unknown> }) => void;
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  allowTransientCooldownProbe?: boolean;
  sessionHasHistory?: boolean;
}) {
  const effectivePrompt = resolveFallbackRetryPrompt({
    body: params.body,
    isFallbackRetry: params.isFallbackRetry,
    sessionHasHistory: params.sessionHasHistory,
  });
  const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.sessionEntry?.systemPromptReport,
  );
  const bootstrapPromptWarningSignature =
    bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
  const authProfileId =
    params.providerOverride === params.authProfileProvider
      ? params.sessionEntry?.authProfileOverride
      : undefined;
  if (isCliProvider(params.providerOverride, params.cfg)) {
    const cliSessionBinding = getCliSessionBinding(params.sessionEntry, params.providerOverride);
    const runCliWithSession = (nextCliSessionId: string | undefined) =>
      runCliAgent({
        agentAccountId: params.runContext.accountId,
        agentId: params.sessionAgentId,
        authProfileId,
        bootstrapPromptWarningSignature,
        bootstrapPromptWarningSignaturesSeen,
        cliSessionBinding:
          nextCliSessionId === cliSessionBinding?.sessionId ? cliSessionBinding : undefined,
        cliSessionId: nextCliSessionId,
        config: params.cfg,
        extraSystemPrompt: params.opts.extraSystemPrompt,
        imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
        images: params.isFallbackRetry ? undefined : params.opts.images,
        messageProvider: params.messageChannel,
        model: params.modelOverride,
        prompt: effectivePrompt,
        provider: params.providerOverride,
        runId: params.runId,
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        skillsSnapshot: params.skillsSnapshot,
        streamParams: params.opts.streamParams,
        thinkLevel: params.resolvedThinkLevel,
        timeoutMs: params.timeoutMs,
        workspaceDir: params.workspaceDir,
      });
    return runCliWithSession(cliSessionBinding?.sessionId).catch(async (error) => {
      if (
        error instanceof FailoverError &&
        error.reason === "session_expired" &&
        cliSessionBinding?.sessionId &&
        params.sessionKey &&
        params.sessionStore &&
        params.storePath
      ) {
        log.warn(
          `CLI session expired, clearing from session store: provider=${sanitizeForLog(params.providerOverride)} sessionKey=${params.sessionKey}`,
        );

        const entry = params.sessionStore[params.sessionKey];
        if (entry) {
          const updatedEntry = { ...entry };
          clearCliSession(updatedEntry, params.providerOverride);
          updatedEntry.updatedAt = Date.now();

          await persistSessionEntry({
            clearedFields: ["cliSessionBindings", "cliSessionIds", "claudeCliSessionId"],
            entry: updatedEntry,
            sessionKey: params.sessionKey,
            sessionStore: params.sessionStore,
            storePath: params.storePath,
          });

          params.sessionEntry = updatedEntry;
        }

        return runCliWithSession(undefined).then(async (result) => {
          if (
            result.meta.agentMeta?.cliSessionBinding?.sessionId &&
            params.sessionKey &&
            params.sessionStore &&
            params.storePath
          ) {
            const entry = params.sessionStore[params.sessionKey];
            if (entry) {
              const updatedEntry = { ...entry };
              setCliSessionBinding(
                updatedEntry,
                params.providerOverride,
                result.meta.agentMeta.cliSessionBinding,
              );
              updatedEntry.updatedAt = Date.now();

              await persistSessionEntry({
                entry: updatedEntry,
                sessionKey: params.sessionKey,
                sessionStore: params.sessionStore,
                storePath: params.storePath,
              });
            }
          }
          return result;
        });
      }
      throw error;
    });
  }

  return runEmbeddedPiAgent({
    abortSignal: params.opts.abortSignal,
    agentAccountId: params.runContext.accountId,
    agentDir: params.agentDir,
    agentId: params.sessionAgentId,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    authProfileId,
    authProfileIdSource: authProfileId ? params.sessionEntry?.authProfileOverrideSource : undefined,
    bootstrapContextMode: params.opts.bootstrapContextMode,
    bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
    bootstrapPromptWarningSignature,
    bootstrapPromptWarningSignaturesSeen,
    cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
    clientTools: params.opts.clientTools,
    config: params.cfg,
    currentChannelId: params.runContext.currentChannelId,
    currentThreadTs: params.runContext.currentThreadTs,
    extraSystemPrompt: params.opts.extraSystemPrompt,
    groupChannel: params.runContext.groupChannel,
    groupId: params.runContext.groupId,
    groupSpace: params.runContext.groupSpace,
    hasRepliedRef: params.runContext.hasRepliedRef,
    imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
    images: params.isFallbackRetry ? undefined : params.opts.images,
    inputProvenance: params.opts.inputProvenance,
    internalEvents: params.opts.internalEvents,
    lane: params.opts.lane,
    messageChannel: params.messageChannel,
    messageThreadId: params.opts.threadId,
    messageTo: params.opts.replyTo ?? params.opts.to,
    model: params.modelOverride,
    onAgentEvent: params.onAgentEvent,
    prompt: effectivePrompt,
    provider: params.providerOverride,
    replyToMode: params.runContext.replyToMode,
    runId: params.runId,
    senderIsOwner: params.opts.senderIsOwner,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    skillsSnapshot: params.skillsSnapshot,
    spawnedBy: params.spawnedBy,
    streamParams: params.opts.streamParams,
    thinkLevel: params.resolvedThinkLevel,
    timeoutMs: params.timeoutMs,
    trigger: "user",
    verboseLevel: params.resolvedVerboseLevel,
    workspaceDir: params.workspaceDir,
  });
}

export function buildAcpResult(params: {
  payloadText: string;
  startedAt: number;
  stopReason?: string;
  abortSignal?: AbortSignal;
}) {
  const normalizedFinalPayload = normalizeReplyPayload({
    text: params.payloadText,
  });
  const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
  return {
    meta: {
      aborted: params.abortSignal?.aborted === true,
      durationMs: Date.now() - params.startedAt,
      stopReason: params.stopReason,
    },
    payloads,
  };
}

export function emitAcpLifecycleStart(params: { runId: string; startedAt: number }) {
  emitAgentEvent({
    data: {
      phase: "start",
      startedAt: params.startedAt,
    },
    runId: params.runId,
    stream: "lifecycle",
  });
}

export function emitAcpLifecycleEnd(params: { runId: string }) {
  emitAgentEvent({
    data: {
      endedAt: Date.now(),
      phase: "end",
    },
    runId: params.runId,
    stream: "lifecycle",
  });
}

export function emitAcpLifecycleError(params: { runId: string; message: string }) {
  emitAgentEvent({
    data: {
      endedAt: Date.now(),
      error: params.message,
      phase: "error",
    },
    runId: params.runId,
    stream: "lifecycle",
  });
}

export function emitAcpAssistantDelta(params: { runId: string; text: string; delta: string }) {
  emitAgentEvent({
    data: {
      delta: params.delta,
      text: params.text,
    },
    runId: params.runId,
    stream: "assistant",
  });
}
