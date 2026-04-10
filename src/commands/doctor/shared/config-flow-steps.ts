import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

export function applyLegacyCompatibilityStep(params: {
  snapshot: DoctorConfigPreflightResult["snapshot"];
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  issueLines: string[];
  changeLines: string[];
} {
  if (params.snapshot.legacyIssues.length === 0) {
    return {
      changeLines: [],
      issueLines: [],
      state: params.state,
    };
  }

  const issueLines = formatConfigIssueLines(params.snapshot.legacyIssues, "-");
  const { config: migrated, changes } = migrateLegacyConfig(params.snapshot.parsed);
  if (!migrated) {
    return {
      changeLines: changes,
      issueLines,
      state: {
        ...params.state,
        fixHints: params.shouldRepair
          ? params.state.fixHints
          : [
              ...params.state.fixHints,
              `Run "${params.doctorFixCommand}" to migrate legacy config keys.`,
            ],
        pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
      },
    };
  }

  return {
    changeLines: changes,
    issueLines,
    state: {
      // Doctor should keep using the best-effort migrated shape in memory even
      // During preview mode; confirmation only controls whether we write it.
      cfg: migrated,
      candidate: migrated,
      // The read path can normalize legacy config into the snapshot before
      // MigrateLegacyConfig emits concrete mutations. Legacy issues still mean
      // The on-disk config needs a doctor --fix path.
      pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [
            ...params.state.fixHints,
            `Run "${params.doctorFixCommand}" to migrate legacy config keys.`,
          ],
    },
  };
}

export function applyUnknownConfigKeyStep(params: {
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  removed: string[];
} {
  const unknown = stripUnknownConfigKeys(params.state.candidate);
  if (unknown.removed.length === 0) {
    return { removed: [], state: params.state };
  }

  return {
    removed: unknown.removed,
    state: {
      candidate: unknown.config,
      cfg: params.shouldRepair ? unknown.config : params.state.cfg,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to remove these keys.`],
      pendingChanges: true,
    },
  };
}
