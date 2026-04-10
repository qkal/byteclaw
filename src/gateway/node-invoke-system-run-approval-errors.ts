export interface SystemRunApprovalGuardError {
  ok: false;
  message: string;
  details: Record<string, unknown>;
}

export function systemRunApprovalGuardError(params: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): SystemRunApprovalGuardError {
  const details = params.details ? { ...params.details } : {};
  return {
    details: {
      code: params.code,
      ...details,
    },
    message: params.message,
    ok: false,
  };
}

export function systemRunApprovalRequired(runId: string): SystemRunApprovalGuardError {
  return systemRunApprovalGuardError({
    code: "APPROVAL_REQUIRED",
    details: { runId },
    message: "approval required",
  });
}
