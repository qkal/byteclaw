import type { OpenClawConfig } from "../../../config/config.js";

export interface DoctorConfigMutationState {
  cfg: OpenClawConfig;
  candidate: OpenClawConfig;
  pendingChanges: boolean;
  fixHints: string[];
}

export interface DoctorConfigMutationResult {
  config: OpenClawConfig;
  changes: string[];
}

export function applyDoctorConfigMutation(params: {
  state: DoctorConfigMutationState;
  mutation: DoctorConfigMutationResult;
  shouldRepair: boolean;
  fixHint?: string;
}): DoctorConfigMutationState {
  if (params.mutation.changes.length === 0) {
    return params.state;
  }

  return {
    candidate: params.mutation.config,
    cfg: params.shouldRepair ? params.mutation.config : params.state.cfg,
    fixHints:
      !params.shouldRepair && params.fixHint
        ? [...params.state.fixHints, params.fixHint]
        : params.state.fixHints,
    pendingChanges: true,
  };
}
