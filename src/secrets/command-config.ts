import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { getPath } from "./path-utils.js";
import { isExpectedResolvedSecretValue } from "./secret-value.js";
import { discoverConfigSecretTargetsByIds } from "./target-registry.js";

export interface CommandSecretAssignment {
  path: string;
  pathSegments: string[];
  value: unknown;
}

export interface ResolveAssignmentsFromSnapshotResult {
  assignments: CommandSecretAssignment[];
  diagnostics: string[];
}

export interface UnresolvedCommandSecretAssignment {
  path: string;
  pathSegments: string[];
}

export interface AnalyzeAssignmentsFromSnapshotResult {
  assignments: CommandSecretAssignment[];
  diagnostics: string[];
  unresolved: UnresolvedCommandSecretAssignment[];
  inactive: UnresolvedCommandSecretAssignment[];
}

export function analyzeCommandSecretAssignmentsFromSnapshot(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  targetIds: ReadonlySet<string>;
  inactiveRefPaths?: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
}): AnalyzeAssignmentsFromSnapshotResult {
  const defaults = params.sourceConfig.secrets?.defaults;
  const assignments: CommandSecretAssignment[] = [];
  const diagnostics: string[] = [];
  const unresolved: UnresolvedCommandSecretAssignment[] = [];
  const inactive: UnresolvedCommandSecretAssignment[] = [];

  for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
    if (params.allowedPaths && !params.allowedPaths.has(target.path)) {
      continue;
    }
    const { explicitRef, ref } = resolveSecretInputRef({
      defaults,
      refValue: target.refValue,
      value: target.value,
    });
    const inlineCandidateRef = explicitRef ? coerceSecretRef(target.value, defaults) : null;
    if (!ref) {
      continue;
    }

    const resolved = getPath(params.resolvedConfig, target.pathSegments);
    if (!isExpectedResolvedSecretValue(resolved, target.entry.expectedResolvedValue)) {
      if (params.inactiveRefPaths?.has(target.path)) {
        diagnostics.push(
          `${target.path}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
        );
        inactive.push({
          path: target.path,
          pathSegments: [...target.pathSegments],
        });
        continue;
      }
      unresolved.push({
        path: target.path,
        pathSegments: [...target.pathSegments],
      });
      continue;
    }

    assignments.push({
      path: target.path,
      pathSegments: [...target.pathSegments],
      value: resolved,
    });

    const hasCompetingSiblingRef =
      target.entry.secretShape === "sibling_ref" && explicitRef && inlineCandidateRef; // Pragma: allowlist secret
    if (hasCompetingSiblingRef) {
      diagnostics.push(
        `${target.path}: both inline and sibling ref were present; sibling ref took precedence.`,
      );
    }
  }

  return { assignments, diagnostics, inactive, unresolved };
}

export function collectCommandSecretAssignmentsFromSnapshot(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  commandName: string;
  targetIds: ReadonlySet<string>;
  inactiveRefPaths?: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
}): ResolveAssignmentsFromSnapshotResult {
  const analyzed = analyzeCommandSecretAssignmentsFromSnapshot({
    allowedPaths: params.allowedPaths,
    inactiveRefPaths: params.inactiveRefPaths,
    resolvedConfig: params.resolvedConfig,
    sourceConfig: params.sourceConfig,
    targetIds: params.targetIds,
  });
  if (analyzed.unresolved.length > 0) {
    throw new Error(
      `${params.commandName}: ${analyzed.unresolved[0]?.path ?? "target"} is unresolved in the active runtime snapshot.`,
    );
  }
  return {
    assignments: analyzed.assignments,
    diagnostics: analyzed.diagnostics,
  };
}
