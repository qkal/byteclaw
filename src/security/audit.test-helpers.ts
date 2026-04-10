import { saveExecApprovals } from "../infra/exec-approvals.js";
import type { SecurityAuditOptions, SecurityAuditReport } from "./audit.js";
import { runSecurityAudit } from "./audit.js";

export const execDockerRawUnavailable: NonNullable<
  SecurityAuditOptions["execDockerRawFn"]
> = async () => ({
    code: 1,
    stderr: Buffer.from("docker unavailable"),
    stdout: Buffer.alloc(0),
  });

export function successfulProbeResult(url: string) {
  return {
    close: null,
    configSnapshot: null,
    connectLatencyMs: 1,
    error: null,
    health: null,
    ok: true,
    presence: null,
    status: null,
    url,
  };
}

export async function audit(
  config: SecurityAuditOptions["config"],
  extra?: Omit<SecurityAuditOptions, "config"> & { preserveExecApprovals?: boolean },
): Promise<SecurityAuditReport> {
  if (!extra?.preserveExecApprovals) {
    saveExecApprovals({ agents: {}, version: 1 });
  }
  const { preserveExecApprovals: _preserveExecApprovals, ...options } = extra ?? {};
  return runSecurityAudit({
    config,
    includeChannelSecurity: false,
    includeFilesystem: false,
    ...options,
  });
}

export function hasFinding(res: SecurityAuditReport, checkId: string, severity?: string): boolean {
  return res.findings.some(
    (finding) => finding.checkId === checkId && (severity == null || finding.severity === severity),
  );
}
