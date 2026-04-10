import {
  type CommandSecretAssignment,
  collectCommandSecretAssignmentsFromSnapshot,
} from "./command-config.js";
import { getActiveSecretsRuntimeSnapshot } from "./runtime.js";

export type { CommandSecretAssignment } from "./command-config.js";

export function resolveCommandSecretsFromActiveRuntimeSnapshot(params: {
  commandName: string;
  targetIds: ReadonlySet<string>;
}): { assignments: CommandSecretAssignment[]; diagnostics: string[]; inactiveRefPaths: string[] } {
  const activeSnapshot = getActiveSecretsRuntimeSnapshot();
  if (!activeSnapshot) {
    throw new Error("Secrets runtime snapshot is not active.");
  }
  if (params.targetIds.size === 0) {
    return { assignments: [], diagnostics: [], inactiveRefPaths: [] };
  }
  const inactiveRefPaths = [
    ...new Set(
      activeSnapshot.warnings
        .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
        .map((warning) => warning.path),
    ),
  ];
  const resolved = collectCommandSecretAssignmentsFromSnapshot({
    commandName: params.commandName,
    inactiveRefPaths: new Set(inactiveRefPaths),
    resolvedConfig: activeSnapshot.config,
    sourceConfig: activeSnapshot.sourceConfig,
    targetIds: params.targetIds,
  });
  return {
    assignments: resolved.assignments,
    diagnostics: resolved.diagnostics,
    inactiveRefPaths,
  };
}
