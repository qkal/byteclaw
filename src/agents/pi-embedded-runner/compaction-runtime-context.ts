import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { SkillSnapshot } from "../skills.js";

export interface EmbeddedCompactionRuntimeContext {
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  authProfileId?: string;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
}

/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and optionally applying runtime defaults.
 */
export function resolveEmbeddedCompactionTarget(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  defaultProvider?: string;
  defaultModel?: string;
}): { provider: string | undefined; model: string | undefined; authProfileId: string | undefined } {
  const provider = params.provider?.trim() || params.defaultProvider;
  const model = params.modelId?.trim() || params.defaultModel;
  const override = params.config?.agents?.defaults?.compaction?.model?.trim();
  if (!override) {
    return {
      authProfileId: params.authProfileId ?? undefined,
      model,
      provider,
    };
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim() || params.defaultModel;
    // When switching provider via override, drop the primary auth profile to
    // Avoid sending the wrong credentials.
    const authProfileId =
      overrideProvider !== (params.provider ?? "")?.trim()
        ? undefined
        : (params.authProfileId ?? undefined);
    return { authProfileId, model: overrideModel, provider: overrideProvider };
  }
  return {
    authProfileId: params.authProfileId ?? undefined,
    model: override,
    provider,
  };
}

export function buildEmbeddedCompactionRuntimeContext(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
}): EmbeddedCompactionRuntimeContext {
  const resolved = resolveEmbeddedCompactionTarget({
    authProfileId: params.authProfileId,
    config: params.config,
    modelId: params.modelId,
    provider: params.provider,
  });
  return {
    agentAccountId: params.agentAccountId ?? undefined,
    agentDir: params.agentDir,
    authProfileId: resolved.authProfileId,
    bashElevated: params.bashElevated,
    config: params.config,
    currentChannelId: params.currentChannelId ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    extraSystemPrompt: params.extraSystemPrompt,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    model: resolved.model,
    ownerNumbers: params.ownerNumbers,
    provider: resolved.provider,
    reasoningLevel: params.reasoningLevel,
    senderId: params.senderId ?? undefined,
    senderIsOwner: params.senderIsOwner,
    sessionKey: params.sessionKey ?? undefined,
    skillsSnapshot: params.skillsSnapshot,
    thinkLevel: params.thinkLevel,
    workspaceDir: params.workspaceDir,
  };
}
