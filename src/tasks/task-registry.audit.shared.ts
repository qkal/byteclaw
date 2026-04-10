import type { TaskRecord } from "./task-registry.types.js";

export type TaskAuditSeverity = "warn" | "error";
export type TaskAuditCode =
  | "stale_queued"
  | "stale_running"
  | "lost"
  | "delivery_failed"
  | "missing_cleanup"
  | "inconsistent_timestamps";

export interface TaskAuditFinding {
  severity: TaskAuditSeverity;
  code: TaskAuditCode;
  task: TaskRecord;
  ageMs?: number;
  detail: string;
}

export interface TaskAuditSummary {
  total: number;
  warnings: number;
  errors: number;
  byCode: Record<TaskAuditCode, number>;
}

export function createEmptyTaskAuditSummary(): TaskAuditSummary {
  return {
    byCode: {
      delivery_failed: 0,
      inconsistent_timestamps: 0,
      lost: 0,
      missing_cleanup: 0,
      stale_queued: 0,
      stale_running: 0,
    },
    errors: 0,
    total: 0,
    warnings: 0,
  };
}
