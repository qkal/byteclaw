import { resolveAgentDir } from "../../agents/agent-scope.js";
import { runBtwSideQuestion } from "../../agents/btw.js";
import { extractBtwQuestion } from "./btw-command.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const BTW_USAGE = "Usage: /btw <side question>";

export const handleBtwCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const question = extractBtwQuestion(params.command.commandBodyNormalized);
  if (question === null) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/btw");
  if (unauthorized) {
    return unauthorized;
  }

  if (!question) {
    return {
      reply: { text: BTW_USAGE },
      shouldContinue: false,
    };
  }

  if (!params.sessionEntry?.sessionId) {
    return {
      reply: { text: "⚠️ /btw requires an active session with existing context." },
      shouldContinue: false,
    };
  }

  const agentDir =
    params.agentDir ?? (params.agentId ? resolveAgentDir(params.cfg, params.agentId) : undefined);

  if (!agentDir) {
    return {
      reply: {
        text: "⚠️ /btw is unavailable because the active agent directory could not be resolved.",
      },
      shouldContinue: false,
    };
  }

  try {
    await params.typing?.startTypingLoop();
    const reply = await runBtwSideQuestion({
      cfg: params.cfg,
      agentDir,
      provider: params.provider,
      model: params.model,
      question,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      // BTW is intentionally a quick side question, so do not inherit slower
      // Session-level think/reasoning settings from the main run.
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      blockReplyChunking: params.blockReplyChunking,
      resolvedBlockStreamingBreak: params.resolvedBlockStreamingBreak,
      opts: params.opts,
      isNewSession: false,
    });
    return {
      reply: reply ? { ...reply, btw: { question } } : reply,
      shouldContinue: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      reply: {
        btw: { question },
        isError: true,
        text: `⚠️ /btw failed${message ? `: ${message}` : "."}`,
      },
      shouldContinue: false,
    };
  }
};
