import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import type { EmbeddedContextFile } from "../../agents/pi-embedded-helpers.js";
import { createOpenClawCodingTools } from "../../agents/pi-tools.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import type { HandleCommandsParams } from "./commands-types.js";

export interface CommandsSystemPromptBundle {
  systemPrompt: string;
  tools: AgentTool[];
  skillsPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  sandboxRuntime: ReturnType<typeof resolveSandboxRuntimeStatus>;
}

export async function resolveCommandsSystemPromptBundle(
  params: HandleCommandsParams,
): Promise<CommandsSystemPromptBundle> {
  const {workspaceDir} = params;
  const { sessionAgentId } = resolveSessionAgentIds({
    agentId: params.agentId,
    config: params.cfg,
    sessionKey: params.sessionKey,
  });
  const { bootstrapFiles, contextFiles: injectedFiles } = await resolveBootstrapContextForRun({
    config: params.cfg,
    sessionId: params.sessionEntry?.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.ctx.SessionKey ?? params.sessionKey,
  });
  const skillsSnapshot = (() => {
    try {
      return buildWorkspaceSkillSnapshot(workspaceDir, {
        agentId: sessionAgentId,
        config: params.cfg,
        eligibility: {
          remote: getRemoteSkillEligibility({
            advertiseExecNode: canExecRequestNode({
              agentId: sessionAgentId,
              cfg: params.cfg,
              sessionEntry: params.sessionEntry,
              sessionKey: params.sessionKey,
            }),
          }),
        },
        snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
      });
    } catch {
      return { prompt: "", resolvedSkills: [], skills: [] };
    }
  })();
  const skillsPrompt = skillsSnapshot.prompt ?? "";
  const tools = (() => {
    try {
      return createOpenClawCodingTools({
        agentId: params.agentId,
        allowGatewaySubagentBinding: true,
        config: params.cfg,
        groupChannel: params.sessionEntry?.groupChannel ?? undefined,
        groupId: params.sessionEntry?.groupId ?? undefined,
        groupSpace: params.sessionEntry?.space ?? undefined,
        messageProvider: params.command.channel,
        modelId: params.model,
        modelProvider: params.provider,
        senderIsOwner: params.command.senderIsOwner,
        sessionKey: params.sessionKey,
        spawnedBy: params.sessionEntry?.spawnedBy ?? undefined,
        workspaceDir,
      });
    } catch {
      return [];
    }
  })();
  const toolNames = tools.map((t) => t.name);
  const defaultModelRef = resolveDefaultModelForAgent({
    agentId: sessionAgentId,
    cfg: params.cfg,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    agentId: sessionAgentId,
    config: params.cfg,
    cwd: process.cwd(),
    runtime: {
      arch: "unknown",
      defaultModel: defaultModelLabel,
      host: "unknown",
      model: `${params.provider}/${params.model}`,
      node: process.version,
      os: "unknown",
    },
    workspaceDir,
  });
  const sandboxInfo = sandboxRuntime.sandboxed
    ? {
        elevated: {
          allowed: params.elevated.allowed,
          defaultLevel: (params.resolvedElevatedLevel ?? "off") as "on" | "off" | "ask" | "full",
        },
        enabled: true,
        workspaceAccess: "rw" as const,
        workspaceDir,
      }
    : { enabled: false };
  const ttsHint = params.cfg ? buildTtsSystemPromptHint(params.cfg) : undefined;

  const systemPrompt = buildAgentSystemPrompt({
    acpEnabled: params.cfg?.acp?.enabled !== false,
    contextFiles: injectedFiles,
    defaultThinkLevel: params.resolvedThinkLevel,
    extraSystemPrompt: undefined,
    heartbeatPrompt: undefined,
    memoryCitationsMode: params.cfg?.memory?.citations,
    modelAliasLines: [],
    ownerNumbers: undefined,
    reasoningLevel: params.resolvedReasoningLevel,
    reasoningTagHint: false,
    runtimeInfo,
    sandboxInfo,
    skillsPrompt,
    toolNames,
    ttsHint,
    userTime,
    userTimeFormat,
    userTimezone,
    workspaceDir,
  });

  return { bootstrapFiles, injectedFiles, sandboxRuntime, skillsPrompt, systemPrompt, tools };
}
