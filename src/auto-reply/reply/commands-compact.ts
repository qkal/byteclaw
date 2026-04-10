import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { CommandHandler } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.length ? rest : undefined;
}

function isCompactionSkipReason(reason?: string): boolean {
  const text = normalizeOptionalLowercaseString(reason) ?? "";
  return (
    text.includes("nothing to compact") ||
    text.includes("below threshold") ||
    text.includes("already compacted") ||
    text.includes("no real conversation messages")
  );
}

function formatCompactionReason(reason?: string): string | undefined {
  const text = normalizeOptionalString(reason);
  if (!text) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(text);
  if (lower.includes("nothing to compact")) {
    return "nothing compactable in this session yet";
  }
  if (lower.includes("below threshold")) {
    return "context is below the compaction threshold";
  }
  if (lower.includes("already compacted")) {
    return "session was already compacted recently";
  }
  if (lower.includes("no real conversation messages")) {
    return "no real conversation messages yet";
  }
  return text;
}

export const handleCompactCommand: CommandHandler = async (params) => {
  const compactRequested =
    params.command.commandBodyNormalized === "/compact" ||
    params.command.commandBodyNormalized.startsWith("/compact ");
  if (!compactRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /compact from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!params.sessionEntry?.sessionId) {
    return {
      reply: { text: "⚙️ Compaction unavailable (missing session id)." },
      shouldContinue: false,
    };
  }
  const runtime = await import("./commands-compact.runtime.js");
  const { sessionId } = params.sessionEntry;
  if (runtime.isEmbeddedPiRunActive(sessionId)) {
    runtime.abortEmbeddedPiRun(sessionId);
    await runtime.waitForEmbeddedPiRunEnd(sessionId, 15_000);
  }
  const customInstructions = extractCompactInstructions({
    agentId: params.agentId,
    cfg: params.cfg,
    ctx: params.ctx,
    isGroup: params.isGroup,
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
  });
  const result = await runtime.compactEmbeddedPiSession({
    agentDir: params.agentDir,
    allowGatewaySubagentBinding: true,
    bashElevated: {
      allowed: false,
      defaultLevel: "off",
      enabled: false,
    },
    config: params.cfg,
    customInstructions,
    groupChannel: params.sessionEntry.groupChannel,
    groupId: params.sessionEntry.groupId,
    groupSpace: params.sessionEntry.space,
    messageChannel: params.command.channel,
    model: params.model,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
    provider: params.provider,
    senderIsOwner: params.command.senderIsOwner,
    sessionFile: runtime.resolveSessionFilePath(
      sessionId,
      params.sessionEntry,
      runtime.resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    ),
    sessionId,
    sessionKey: params.sessionKey,
    skillsSnapshot: params.sessionEntry.skillsSnapshot,
    spawnedBy: params.sessionEntry.spawnedBy,
    thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    trigger: "manual",
    workspaceDir: params.workspaceDir,
  });

  const compactLabel =
    result.ok || isCompactionSkipReason(result.reason)
      ? result.compacted
        ? result.result?.tokensBefore != null && result.result?.tokensAfter != null
          ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(result.result.tokensAfter)})`
          : result.result?.tokensBefore
            ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} before)`
            : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
  if (result.ok && result.compacted) {
    await runtime.incrementCompactionCount({
      cfg: params.cfg,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      // Update token counts after compaction
      tokensAfter: result.result?.tokensAfter,
    });
  }
  // Use the post-compaction token count for context summary if available
  const tokensAfterCompaction = result.result?.tokensAfter;
  const totalTokens =
    tokensAfterCompaction ?? runtime.resolveFreshSessionTotalTokens(params.sessionEntry);
  const contextSummary = runtime.formatContextUsageShort(
    typeof totalTokens === "number" && totalTokens > 0 ? totalTokens : null,
    params.contextTokens ?? params.sessionEntry.contextTokens ?? null,
  );
  const reason = formatCompactionReason(result.reason);
  const line = reason
    ? `${compactLabel}: ${reason} • ${contextSummary}`
    : `${compactLabel} • ${contextSummary}`;
  runtime.enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  return { reply: { text: `⚙️ ${line}` }, shouldContinue: false };
};
