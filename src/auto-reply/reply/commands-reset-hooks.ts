import fs from "node:fs/promises";
import path from "node:path";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { HandleCommandsParams } from "./commands-types.js";

let routeReplyRuntimePromise: Promise<typeof import("./route-reply.runtime.js")> | null = null;

function loadRouteReplyRuntime() {
  routeReplyRuntimePromise ??= import("./route-reply.runtime.js");
  return routeReplyRuntimePromise;
}

export type ResetCommandAction = "new" | "reset";

function parseTranscriptMessages(content: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        messages.push(entry.message);
      }
    } catch {
      // Skip malformed lines from partially-written transcripts.
    }
  }
  return messages;
}

async function findLatestArchivedTranscript(sessionFile: string): Promise<string | undefined> {
  try {
    const dir = path.dirname(sessionFile);
    const base = path.basename(sessionFile);
    const resetPrefix = `${base}.reset.`;
    const archived = (await fs.readdir(dir))
      .filter((name) => name.startsWith(resetPrefix))
      .toSorted();
    const latest = archived[archived.length - 1];
    return latest ? path.join(dir, latest) : undefined;
  } catch {
    return undefined;
  }
}

async function loadBeforeResetTranscript(params: {
  sessionFile?: string;
}): Promise<{ sessionFile?: string; messages: unknown[] }> {
  const {sessionFile} = params;
  if (!sessionFile) {
    logVerbose("before_reset: no session file available, firing hook with empty messages");
    return { messages: [], sessionFile };
  }

  try {
    return {
      messages: parseTranscriptMessages(await fs.readFile(sessionFile, "utf8")),
      sessionFile,
    };
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code !== "ENOENT") {
      logVerbose(
        `before_reset: failed to read session file ${sessionFile}; firing hook with empty messages (${String(error)})`,
      );
      return { messages: [], sessionFile };
    }
  }

  const archivedSessionFile = await findLatestArchivedTranscript(sessionFile);
  if (!archivedSessionFile) {
    logVerbose(
      `before_reset: failed to find archived transcript for ${sessionFile}; firing hook with empty messages`,
    );
    return { messages: [], sessionFile };
  }

  try {
    return {
      messages: parseTranscriptMessages(await fs.readFile(archivedSessionFile, "utf8")),
      sessionFile: archivedSessionFile,
    };
  } catch (error: unknown) {
    logVerbose(
      `before_reset: failed to read archived session file ${archivedSessionFile}; firing hook with empty messages (${String(error)})`,
    );
    return { messages: [], sessionFile: archivedSessionFile };
  }
}

export async function emitResetCommandHooks(params: {
  action: ResetCommandAction;
  ctx: HandleCommandsParams["ctx"];
  cfg: HandleCommandsParams["cfg"];
  command: Pick<
    HandleCommandsParams["command"],
    "surface" | "senderId" | "channel" | "from" | "to" | "resetHookTriggered"
  >;
  sessionKey?: string;
  sessionEntry?: HandleCommandsParams["sessionEntry"];
  previousSessionEntry?: HandleCommandsParams["previousSessionEntry"];
  workspaceDir: string;
}): Promise<void> {
  const hookEvent = createInternalHookEvent("command", params.action, params.sessionKey ?? "", {
    cfg: params.cfg,
    commandSource: params.command.surface,
    previousSessionEntry: params.previousSessionEntry,
    senderId: params.command.senderId,
    sessionEntry: params.sessionEntry,
    workspaceDir: params.workspaceDir,
  });
  await triggerInternalHook(hookEvent);
  params.command.resetHookTriggered = true;

  if (hookEvent.messages.length > 0) {
    const channel = params.ctx.OriginatingChannel || params.command.channel;
    const to = params.ctx.OriginatingTo || params.command.from || params.command.to;
    if (channel && to) {
      const { routeReply } = await loadRouteReplyRuntime();
      await routeReply({
        accountId: params.ctx.AccountId,
        cfg: params.cfg,
        channel,
        payload: { text: hookEvent.messages.join("\n\n") },
        sessionKey: params.sessionKey,
        threadId: params.ctx.MessageThreadId,
        to,
      });
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_reset")) {
    const prevEntry = params.previousSessionEntry;
    void (async () => {
      const { sessionFile, messages } = await loadBeforeResetTranscript({
        sessionFile: prevEntry?.sessionFile,
      });

      try {
        await hookRunner.runBeforeReset(
          { messages, reason: params.action, sessionFile },
          {
            agentId: resolveAgentIdFromSessionKey(params.sessionKey),
            sessionId: prevEntry?.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
          },
        );
      } catch (error: unknown) {
        logVerbose(`before_reset hook failed: ${String(error)}`);
      }
    })();
  }
}
