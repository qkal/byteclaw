import { spawnSubagentDirect } from "../../../agents/subagent-spawn.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { type SubagentsCommandContext, stopWithText } from "./shared.js";

export async function handleSubagentsSpawnAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, requesterKey, restTokens } = ctx;
  const agentId = restTokens[0];

  const taskParts: string[] = [];
  let model: string | undefined;
  let thinking: string | undefined;
  for (let i = 1; i < restTokens.length; i++) {
    if (restTokens[i] === "--model" && i + 1 < restTokens.length) {
      i += 1;
      model = restTokens[i];
    } else if (restTokens[i] === "--thinking" && i + 1 < restTokens.length) {
      i += 1;
      thinking = restTokens[i];
    } else {
      taskParts.push(restTokens[i]);
    }
  }
  const task = taskParts.join(" ").trim();
  if (!agentId || !task) {
    return stopWithText(
      "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
    );
  }

  const commandTo = normalizeOptionalString(params.command.to) ?? "";
  const originatingTo = normalizeOptionalString(params.ctx.OriginatingTo) ?? "";
  const fallbackTo = normalizeOptionalString(params.ctx.To) ?? "";
  const normalizedTo = originatingTo || commandTo || fallbackTo || undefined;

  const result = await spawnSubagentDirect(
    {
      agentId,
      cleanup: "keep",
      expectsCompletionMessage: true,
      mode: "run",
      model,
      task,
      thinking,
    },
    {
      agentAccountId: params.ctx.AccountId,
      agentChannel: params.ctx.OriginatingChannel ?? params.command.channel,
      agentGroupChannel: params.sessionEntry?.groupChannel ?? null,
      agentGroupId: params.sessionEntry?.groupId ?? null,
      agentGroupSpace: params.sessionEntry?.space ?? null,
      agentSessionKey: requesterKey,
      agentThreadId: params.ctx.MessageThreadId,
      agentTo: normalizedTo,
    },
  );
  if (result.status === "accepted") {
    return stopWithText(
      `Spawned subagent ${agentId} (session ${result.childSessionKey}, run ${result.runId?.slice(0, 8)}).`,
    );
  }
  return stopWithText(`Spawn failed: ${result.error ?? result.status}`);
}
