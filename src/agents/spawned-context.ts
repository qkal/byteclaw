import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

export interface SpawnedRunMetadata {
  spawnedBy?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  workspaceDir?: string | null;
}

export interface SpawnedToolContext {
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  workspaceDir?: string;
}

export interface NormalizedSpawnedRunMetadata {
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  workspaceDir?: string;
}

export function normalizeSpawnedRunMetadata(
  value?: SpawnedRunMetadata | null,
): NormalizedSpawnedRunMetadata {
  return {
    groupChannel: normalizeOptionalString(value?.groupChannel),
    groupId: normalizeOptionalString(value?.groupId),
    groupSpace: normalizeOptionalString(value?.groupSpace),
    spawnedBy: normalizeOptionalString(value?.spawnedBy),
    workspaceDir: normalizeOptionalString(value?.workspaceDir),
  };
}

export function mapToolContextToSpawnedRunMetadata(
  value?: SpawnedToolContext | null,
): Pick<NormalizedSpawnedRunMetadata, "groupId" | "groupChannel" | "groupSpace" | "workspaceDir"> {
  return {
    groupChannel: normalizeOptionalString(value?.agentGroupChannel),
    groupId: normalizeOptionalString(value?.agentGroupId),
    groupSpace: normalizeOptionalString(value?.agentGroupSpace),
    workspaceDir: normalizeOptionalString(value?.workspaceDir),
  };
}

export function resolveSpawnedWorkspaceInheritance(params: {
  config: OpenClawConfig;
  targetAgentId?: string;
  requesterSessionKey?: string;
  explicitWorkspaceDir?: string | null;
}): string | undefined {
  const explicit = normalizeOptionalString(params.explicitWorkspaceDir);
  if (explicit) {
    return explicit;
  }
  // For cross-agent spawns, use the target agent's workspace instead of the requester's.
  const agentId =
    params.targetAgentId ??
    (params.requesterSessionKey
      ? parseAgentSessionKey(params.requesterSessionKey)?.agentId
      : undefined);
  return agentId ? resolveAgentWorkspaceDir(params.config, normalizeAgentId(agentId)) : undefined;
}

export function resolveIngressWorkspaceOverrideForSpawnedRun(
  metadata?: Pick<SpawnedRunMetadata, "spawnedBy" | "workspaceDir"> | null,
): string | undefined {
  const normalized = normalizeSpawnedRunMetadata(metadata);
  return normalized.spawnedBy ? normalized.workspaceDir : undefined;
}
