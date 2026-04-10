import { canExecRequestNode } from "../../agents/exec-defaults.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildWorkspaceSkillSnapshot,
  getRemoteSkillEligibility,
  getSkillsSnapshotVersion,
  resolveAgentSkillsFilter,
} from "./run.runtime.js";

export function resolveCronSkillsSnapshot(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  existingSnapshot?: SkillSnapshot;
  isFastTestEnv: boolean;
}): SkillSnapshot {
  if (params.isFastTestEnv) {
    // Fast unit-test mode skips filesystem scans and snapshot refresh writes.
    return params.existingSnapshot ?? { prompt: "", skills: [] };
  }

  const snapshotVersion = getSkillsSnapshotVersion(params.workspaceDir);
  const skillFilter = resolveAgentSkillsFilter(params.config, params.agentId);
  const {existingSnapshot} = params;
  const shouldRefresh =
    !existingSnapshot ||
    existingSnapshot.version !== snapshotVersion ||
    !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter);
  if (!shouldRefresh) {
    return existingSnapshot;
  }

  return buildWorkspaceSkillSnapshot(params.workspaceDir, {
    agentId: params.agentId,
    config: params.config,
    eligibility: {
      remote: getRemoteSkillEligibility({
        advertiseExecNode: canExecRequestNode({
          agentId: params.agentId,
          cfg: params.config,
        }),
      }),
    },
    skillFilter,
    snapshotVersion,
  });
}
