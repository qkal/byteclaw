import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  type SystemRunApprovalMatchResult,
  buildSystemRunApprovalBinding,
  matchSystemRunApprovalBinding,
  missingSystemRunApprovalBinding,
} from "../infra/system-run-approval-binding.js";

export interface SystemRunApprovalBinding {
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
  env?: unknown;
}

function requestMismatch(): SystemRunApprovalMatchResult {
  return {
    code: "APPROVAL_REQUEST_MISMATCH",
    message: "approval id does not match request",
    ok: false,
  };
}

export { toSystemRunApprovalMismatchError } from "../infra/system-run-approval-binding.js";
export type { SystemRunApprovalMatchResult } from "../infra/system-run-approval-binding.js";

export function evaluateSystemRunApprovalMatch(params: {
  argv: string[];
  request: ExecApprovalRequestPayload;
  binding: SystemRunApprovalBinding;
}): SystemRunApprovalMatchResult {
  if (params.request.host !== "node") {
    return requestMismatch();
  }

  const actualBinding = buildSystemRunApprovalBinding({
    agentId: params.binding.agentId,
    argv: params.argv,
    cwd: params.binding.cwd,
    env: params.binding.env,
    sessionKey: params.binding.sessionKey,
  });

  const expectedBinding = params.request.systemRunBinding;
  if (!expectedBinding) {
    return missingSystemRunApprovalBinding({
      actualEnvKeys: actualBinding.envKeys,
    });
  }
  return matchSystemRunApprovalBinding({
    actual: actualBinding.binding,
    actualEnvKeys: actualBinding.envKeys,
    expected: expectedBinding,
  });
}
