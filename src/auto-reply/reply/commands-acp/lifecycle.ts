import { randomUUID } from "node:crypto";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import { resolveAcpSessionResolutionError } from "../../../acp/control-plane/manager.utils.js";
import {
  type AcpSpawnRuntimeCloseHandle,
  cleanupFailedAcpSpawn,
} from "../../../acp/control-plane/spawn.js";
import {
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
  resolveAcpDispatchPolicyMessage,
} from "../../../acp/policy.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import { resolveAcpSpawnRuntimePolicyError } from "../../../agents/acp-spawn.js";
import { getChannelPlugin, normalizeChannelId } from "../../../channels/plugins/index.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  requiresNativeThreadContextForThreadHere,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingPlacementForCurrentContext,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { updateSessionStore } from "../../../config/sessions.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  type ConversationRef,
  type SessionBindingPlacement,
  type SessionBindingRecord,
  type SessionBindingService,
  getSessionBindingService,
} from "../../../infra/outbound/session-binding-service.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  resolveAcpCommandAccountId,
  resolveAcpCommandBindingContext,
  resolveAcpCommandConversationId,
  resolveAcpCommandThreadId,
} from "./context.js";
import {
  ACP_STEER_OUTPUT_LIMIT,
  type AcpSpawnBindMode,
  type AcpSpawnThreadMode,
  collectAcpErrorText,
  parseSpawnInput,
  parseSteerInput,
  resolveCommandRequestId,
  stopWithText,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

function resolveAcpBindingLabelNoun(params: {
  conversationId?: string;
  placement: "current" | "child";
  threadId?: string;
}): string {
  if (params.placement === "child") {
    return "thread";
  }
  if (!params.threadId) {
    return "conversation";
  }
  return params.conversationId === params.threadId ? "thread" : "conversation";
}

async function resolveBoundReplyChannelData(params: {
  binding: SessionBindingRecord;
  placement: "current" | "child";
}): Promise<Record<string, unknown> | undefined> {
  const channelId = normalizeChannelId(params.binding.conversation.channel);
  if (!channelId) {
    return undefined;
  }
  const buildChannelData =
    getChannelPlugin(channelId)?.conversationBindings?.buildBoundReplyChannelData;
  if (!buildChannelData) {
    return undefined;
  }
  const resolved = await buildChannelData({
    conversation: params.binding.conversation,
    operation: "acp-spawn",
    placement: params.placement,
  });
  return resolved ?? undefined;
}

function buildSpawnedAcpBindingMetadata(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  sessionKey: string;
  agentId: string;
  label: string;
  senderId: string;
  sessionMeta?: SessionAcpMeta;
}): Record<string, unknown> {
  return {
    agentId: params.agentId,
    boundBy: params.senderId || "unknown",
    introText: resolveThreadBindingIntroText({
      agentId: params.agentId,
      idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
      }),
      label: params.label,
      maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
      }),
      sessionCwd: resolveAcpSessionCwd(params.sessionMeta),
      sessionDetails: resolveAcpThreadSessionDetailLines({
        sessionKey: params.sessionKey,
        meta: params.sessionMeta,
      }),
    }),
    label: params.label,
    threadName: resolveThreadBindingThreadName({
      agentId: params.agentId,
      label: params.label,
    }),
  };
}

async function bindSpawnedAcpSession(params: {
  bindingService: SessionBindingService;
  sessionKey: string;
  conversationRef: ConversationRef;
  placement: SessionBindingPlacement;
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  agentId: string;
  label: string;
  senderId: string;
  sessionMeta?: SessionAcpMeta;
  bindError: string;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  try {
    const binding = await params.bindingService.bind({
      conversation: params.conversationRef,
      metadata: buildSpawnedAcpBindingMetadata({
        accountId: params.accountId,
        agentId: params.agentId,
        cfg: params.cfg,
        channel: params.channel,
        label: params.label,
        senderId: params.senderId,
        sessionKey: params.sessionKey,
        sessionMeta: params.sessionMeta,
      }),
      placement: params.placement,
      targetKind: "session",
      targetSessionKey: params.sessionKey,
    });
    return {
      binding,
      ok: true,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    return {
      error: message || params.bindError,
      ok: false,
    };
  }
}

async function bindSpawnedAcpSessionToCurrentConversation(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
  bindMode: AcpSpawnBindMode;
  sessionMeta?: SessionAcpMeta;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  if (params.bindMode === "off") {
    return {
      error: "internal: conversation binding is disabled for this spawn",
      ok: false,
    };
  }

  const bindingContext = resolveAcpCommandBindingContext(params.commandParams);
  const { channel } = bindingContext;
  if (!channel) {
    return {
      error: "ACP current-conversation binding requires a channel context.",
      ok: false,
    };
  }

  const accountId = resolveAcpCommandAccountId(params.commandParams);
  const bindingPolicy = resolveThreadBindingSpawnPolicy({
    accountId,
    cfg: params.commandParams.cfg,
    channel,
    kind: "acp",
  });
  if (!bindingPolicy.enabled) {
    return {
      error: formatThreadBindingDisabledError({
        accountId: bindingPolicy.accountId,
        channel: bindingPolicy.channel,
        kind: "acp",
      }),
      ok: false,
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    accountId: bindingPolicy.accountId,
    channel: bindingPolicy.channel,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return {
      error: `Conversation bindings are unavailable for ${channel}.`,
      ok: false,
    };
  }
  if (!capabilities.placements.includes("current")) {
    return {
      error: `Conversation bindings do not support current placement for ${channel}.`,
      ok: false,
    };
  }

  const currentConversationId = normalizeOptionalString(bindingContext.conversationId) ?? "";
  if (!currentConversationId) {
    return {
      error: `--bind here requires running /acp spawn inside an active ${channel} conversation.`,
      ok: false,
    };
  }

  const senderId = normalizeOptionalString(params.commandParams.command.senderId) ?? "";
  const parentConversationId = normalizeOptionalString(bindingContext.parentConversationId);
  const conversationRef = {
    accountId: bindingPolicy.accountId,
    channel: bindingPolicy.channel,
    conversationId: currentConversationId,
    ...(parentConversationId && parentConversationId !== currentConversationId
      ? { parentConversationId }
      : {}),
  };
  const existingBinding = bindingService.resolveByConversation(conversationRef);
  const boundBy = normalizeOptionalString(existingBinding?.metadata?.boundBy) ?? "";
  if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    const currentLabel = resolveAcpBindingLabelNoun({
      conversationId: currentConversationId,
      placement: "current",
      threadId: bindingContext.threadId,
    });
    return {
      error: `Only ${boundBy} can rebind this ${currentLabel}.`,
      ok: false,
    };
  }

  const label = params.label || params.agentId;
  return bindSpawnedAcpSession({
    accountId: bindingPolicy.accountId,
    agentId: params.agentId,
    bindError: `Failed to bind the current ${channel} conversation to the new ACP session.`,
    bindingService,
    cfg: params.commandParams.cfg,
    channel: bindingPolicy.channel,
    conversationRef,
    label,
    placement: "current",
    senderId,
    sessionKey: params.sessionKey,
    sessionMeta: params.sessionMeta,
  });
}

async function bindSpawnedAcpSessionToThread(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
  threadMode: AcpSpawnThreadMode;
  sessionMeta?: SessionAcpMeta;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  const { commandParams, threadMode } = params;
  if (threadMode === "off") {
    return {
      error: "internal: thread binding is disabled for this spawn",
      ok: false,
    };
  }

  const bindingContext = resolveAcpCommandBindingContext(commandParams);
  const { channel } = bindingContext;
  if (!channel) {
    return {
      error: "ACP thread binding requires a channel context.",
      ok: false,
    };
  }

  const accountId = resolveAcpCommandAccountId(commandParams);
  const spawnPolicy = resolveThreadBindingSpawnPolicy({
    accountId,
    cfg: commandParams.cfg,
    channel,
    kind: "acp",
  });
  if (!spawnPolicy.enabled) {
    return {
      error: formatThreadBindingDisabledError({
        accountId: spawnPolicy.accountId,
        channel: spawnPolicy.channel,
        kind: "acp",
      }),
      ok: false,
    };
  }
  if (!spawnPolicy.spawnEnabled) {
    return {
      error: formatThreadBindingSpawnDisabledError({
        accountId: spawnPolicy.accountId,
        channel: spawnPolicy.channel,
        kind: "acp",
      }),
      ok: false,
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    accountId: spawnPolicy.accountId,
    channel: spawnPolicy.channel,
  });
  if (!capabilities.adapterAvailable) {
    return {
      error: `Thread bindings are unavailable for ${channel}.`,
      ok: false,
    };
  }
  if (!capabilities.bindSupported) {
    return {
      error: `Thread bindings are unavailable for ${channel}.`,
      ok: false,
    };
  }

  const currentThreadId = bindingContext.threadId ?? "";
  const currentConversationId = normalizeOptionalString(bindingContext.conversationId) ?? "";
  const requiresThreadIdForHere = requiresNativeThreadContextForThreadHere(channel);
  if (
    threadMode === "here" &&
    ((requiresThreadIdForHere && !currentThreadId) ||
      (!requiresThreadIdForHere && !currentConversationId))
  ) {
    return {
      error: `--thread here requires running /acp spawn inside an active ${channel} thread/conversation.`,
      ok: false,
    };
  }

  const placement = resolveThreadBindingPlacementForCurrentContext({
    channel,
    threadId: currentThreadId || undefined,
  });
  if (!capabilities.placements.includes(placement)) {
    return {
      error: `Thread bindings do not support ${placement} placement for ${channel}.`,
      ok: false,
    };
  }
  if (!currentConversationId) {
    return {
      error: `Could not resolve a ${channel} conversation for ACP thread spawn.`,
      ok: false,
    };
  }

  const senderId = normalizeOptionalString(commandParams.command.senderId) ?? "";
  const parentConversationId = normalizeOptionalString(bindingContext.parentConversationId);
  const conversationRef = {
    accountId: spawnPolicy.accountId,
    channel: spawnPolicy.channel,
    conversationId: currentConversationId,
    ...(parentConversationId && parentConversationId !== currentConversationId
      ? { parentConversationId }
      : {}),
  };
  if (placement === "current") {
    const existingBinding = bindingService.resolveByConversation(conversationRef);
    const boundBy = normalizeOptionalString(existingBinding?.metadata?.boundBy) ?? "";
    if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      const currentLabel = resolveAcpBindingLabelNoun({
        conversationId: currentConversationId,
        placement,
        threadId: currentThreadId || undefined,
      });
      return {
        error: `Only ${boundBy} can rebind this ${currentLabel}.`,
        ok: false,
      };
    }
  }

  const label = params.label || params.agentId;
  return bindSpawnedAcpSession({
    accountId: spawnPolicy.accountId,
    agentId: params.agentId,
    bindError: `Failed to bind a ${channel} thread/conversation to the new ACP session.`,
    bindingService,
    cfg: commandParams.cfg,
    channel: spawnPolicy.channel,
    conversationRef,
    label,
    placement,
    senderId,
    sessionKey: params.sessionKey,
    sessionMeta: params.sessionMeta,
  });
}

async function cleanupFailedSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  shouldDeleteSession: boolean;
  initializedRuntime?: AcpSpawnRuntimeCloseHandle;
}) {
  await cleanupFailedAcpSpawn({
    cfg: params.cfg,
    deleteTranscript: false,
    runtimeCloseHandle: params.initializedRuntime,
    sessionKey: params.sessionKey,
    shouldDeleteSession: params.shouldDeleteSession,
  });
}

async function persistSpawnedSessionLabel(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  label?: string;
}): Promise<void> {
  const label = normalizeOptionalString(params.label);
  if (!label) {
    return;
  }

  const now = Date.now();
  if (params.commandParams.sessionStore) {
    const existing = params.commandParams.sessionStore[params.sessionKey];
    if (existing) {
      params.commandParams.sessionStore[params.sessionKey] = {
        ...existing,
        label,
        updatedAt: now,
      };
    }
  }
  if (!params.commandParams.storePath) {
    return;
  }
  await updateSessionStore(params.commandParams.storePath, (store) => {
    const existing = store[params.sessionKey];
    if (!existing) {
      return;
    }
    store[params.sessionKey] = {
      ...existing,
      label,
      updatedAt: now,
    };
  });
}

export async function handleAcpSpawnAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return stopWithText("ACP is disabled by policy (`acp.enabled=false`).");
  }

  const parsed = parseSpawnInput(params, restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }

  const spawn = parsed.value;
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg: params.cfg,
    requesterSessionKey: params.sessionKey,
  });
  if (runtimePolicyError) {
    return stopWithText(`⚠️ ${runtimePolicyError}`);
  }
  const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, spawn.agentId);
  if (agentPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: agentPolicyError,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "ACP target agent is not allowed by policy.",
      }),
    );
  }

  const acpManager = getAcpSessionManager();
  const sessionKey = `agent:${spawn.agentId}:acp:${randomUUID()}`;

  let initializedBackend = "";
  let initializedMeta: SessionAcpMeta | undefined;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    const initialized = await acpManager.initializeSession({
      agent: spawn.agentId,
      cfg: params.cfg,
      cwd: spawn.cwd,
      mode: spawn.mode,
      sessionKey,
    });
    initializedRuntime = {
      handle: initialized.handle,
      runtime: initialized.runtime,
    };
    initializedBackend = initialized.handle.backend || initialized.meta.backend;
    initializedMeta = initialized.meta;
  } catch (error) {
    return stopWithText(
      collectAcpErrorText({
        error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      }),
    );
  }

  let binding: SessionBindingRecord | null = null;
  if (spawn.bind !== "off") {
    const bound = await bindSpawnedAcpSessionToCurrentConversation({
      agentId: spawn.agentId,
      bindMode: spawn.bind,
      commandParams: params,
      label: spawn.label,
      sessionKey,
      sessionMeta: initializedMeta,
    });
    if (!bound.ok) {
      await cleanupFailedSpawn({
        cfg: params.cfg,
        initializedRuntime,
        sessionKey,
        shouldDeleteSession: true,
      });
      return stopWithText(`⚠️ ${bound.error}`);
    }
    ({ binding } = bound);
  } else if (spawn.thread !== "off") {
    const bound = await bindSpawnedAcpSessionToThread({
      agentId: spawn.agentId,
      commandParams: params,
      label: spawn.label,
      sessionKey,
      sessionMeta: initializedMeta,
      threadMode: spawn.thread,
    });
    if (!bound.ok) {
      await cleanupFailedSpawn({
        cfg: params.cfg,
        initializedRuntime,
        sessionKey,
        shouldDeleteSession: true,
      });
      return stopWithText(`⚠️ ${bound.error}`);
    }
    ({ binding } = bound);
  }

  try {
    await persistSpawnedSessionLabel({
      commandParams: params,
      label: spawn.label,
      sessionKey,
    });
  } catch (error) {
    await cleanupFailedSpawn({
      cfg: params.cfg,
      initializedRuntime,
      sessionKey,
      shouldDeleteSession: true,
    });
    const message = formatErrorMessage(error);
    return stopWithText(`⚠️ ACP spawn failed: ${message}`);
  }

  const parts = [
    `✅ Spawned ACP session ${sessionKey} (${spawn.mode}, backend ${initializedBackend}).`,
  ];
  if (binding) {
    const currentConversationId =
      normalizeOptionalString(resolveAcpCommandConversationId(params)) ?? "";
    const boundConversationId = binding.conversation.conversationId.trim();
    const bindingPlacement =
      currentConversationId && boundConversationId === currentConversationId ? "current" : "child";
    const placementLabel = resolveAcpBindingLabelNoun({
      conversationId: currentConversationId,
      placement: bindingPlacement,
      threadId: resolveAcpCommandThreadId(params),
    });
    if (bindingPlacement === "current") {
      parts.push(`Bound this ${placementLabel} to ${sessionKey}.`);
    } else {
      parts.push(`Created ${placementLabel} ${boundConversationId} and bound it to ${sessionKey}.`);
    }
    const channelData = await resolveBoundReplyChannelData({
      binding,
      placement: bindingPlacement,
    });
    if (channelData) {
      return {
        reply: {
          channelData,
          text: parts.join(" "),
        },
        shouldContinue: false,
      };
    }
  } else {
    parts.push(
      "Session is unbound (use /acp spawn ... --bind here to bind this conversation, or /focus <session-key> where supported).",
    );
  }

  const dispatchNote = resolveAcpDispatchPolicyMessage(params.cfg);
  if (dispatchNote) {
    parts.push(`ℹ️ ${dispatchNote}`);
  }

  return stopWithText(parts.join(" "));
}

function resolveAcpSessionForCommandOrStop(params: {
  acpManager: ReturnType<typeof getAcpSessionManager>;
  cfg: OpenClawConfig;
  sessionKey: string;
}): CommandHandlerResult | null {
  const resolved = params.acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const error = resolveAcpSessionResolutionError(resolved);
  if (error) {
    return stopWithText(
      collectAcpErrorText({
        error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: error.message,
      }),
    );
  }
  return null;
}

async function resolveAcpTokenTargetSessionKeyOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
}): Promise<string | CommandHandlerResult> {
  const token = normalizeOptionalString(params.restTokens.join(" "));
  const target = await resolveAcpTargetSessionKey({
    commandParams: params.commandParams,
    token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  return target.sessionKey;
}

async function withResolvedAcpSessionTarget(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  run: (ctx: {
    acpManager: ReturnType<typeof getAcpSessionManager>;
    sessionKey: string;
  }) => Promise<CommandHandlerResult>;
}): Promise<CommandHandlerResult> {
  const acpManager = getAcpSessionManager();
  const targetSessionKey = await resolveAcpTokenTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    restTokens: params.restTokens,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }
  const guardFailure = resolveAcpSessionForCommandOrStop({
    acpManager,
    cfg: params.commandParams.cfg,
    sessionKey: targetSessionKey,
  });
  if (guardFailure) {
    return guardFailure;
  }
  return await params.run({
    acpManager,
    sessionKey: targetSessionKey,
  });
}

export async function handleAcpCancelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withResolvedAcpSessionTarget({
    commandParams: params,
    restTokens,
    run: async ({ acpManager, sessionKey }) =>
      await withAcpCommandErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP cancel failed before completion.",
        onSuccess: () => stopWithText(`✅ Cancel requested for ACP session ${sessionKey}.`),
        run: async () =>
          await acpManager.cancelSession({
            cfg: params.cfg,
            reason: "manual-cancel",
            sessionKey,
          }),
      }),
  });
}

async function runAcpSteer(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  instruction: string;
  requestId: string;
}): Promise<string> {
  const acpManager = getAcpSessionManager();
  let output = "";

  await acpManager.runTurn({
    cfg: params.cfg,
    mode: "steer",
    onEvent: (event) => {
      if (event.type !== "text_delta") {
        return;
      }
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (event.text) {
        output += event.text;
        if (output.length > ACP_STEER_OUTPUT_LIMIT) {
          output = `${output.slice(0, ACP_STEER_OUTPUT_LIMIT)}…`;
        }
      }
    },
    requestId: params.requestId,
    sessionKey: params.sessionKey,
    text: params.instruction,
  });
  return output.trim();
}

export async function handleAcpSteerAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
  if (dispatchPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: dispatchPolicyError,
        fallbackCode: "ACP_DISPATCH_DISABLED",
        fallbackMessage: dispatchPolicyError.message,
      }),
    );
  }

  const parsed = parseSteerInput(restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const acpManager = getAcpSessionManager();

  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const guardFailure = resolveAcpSessionForCommandOrStop({
    acpManager,
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (guardFailure) {
    return guardFailure;
  }

  return await withAcpCommandErrorBoundary({
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP steer failed before completion.",
    onSuccess: (steerOutput) => {
      if (!steerOutput) {
        return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.`);
      }
      return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.\n${steerOutput}`);
    },
    run: async () =>
      await runAcpSteer({
        cfg: params.cfg,
        instruction: parsed.value.instruction,
        requestId: `${resolveCommandRequestId(params)}:steer`,
        sessionKey: target.sessionKey,
      }),
  });
}

export async function handleAcpCloseAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withResolvedAcpSessionTarget({
    commandParams: params,
    restTokens,
    run: async ({ acpManager, sessionKey }) => {
      let runtimeNotice = "";
      try {
        const closed = await acpManager.closeSession({
          allowBackendUnavailable: true,
          cfg: params.cfg,
          clearMeta: true,
          reason: "manual-close",
          sessionKey,
        });
        runtimeNotice = closed.runtimeNotice ? ` (${closed.runtimeNotice})` : "";
      } catch (error) {
        return stopWithText(
          collectAcpErrorText({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
          }),
        );
      }

      const removedBindings = await getSessionBindingService().unbind({
        reason: "manual",
        targetSessionKey: sessionKey,
      });

      return stopWithText(
        `✅ Closed ACP session ${sessionKey}${runtimeNotice}. Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
      );
    },
  });
}
