import type { CronSchedule } from "../../cron/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { parseAt, parseCronStaggerMs, parseDurationMs } from "./shared.js";

interface ScheduleOptionInput {
  at?: unknown;
  cron?: unknown;
  every?: unknown;
  exact?: unknown;
  stagger?: unknown;
  tz?: unknown;
}

interface NormalizedScheduleOptions {
  at: string;
  cronExpr: string;
  every: string;
  requestedStaggerMs: number | undefined;
  tz: string | undefined;
}

export type CronEditScheduleRequest =
  | { kind: "direct"; schedule: CronSchedule }
  | { kind: "patch-existing-cron"; staggerMs: number | undefined; tz: string | undefined }
  | { kind: "none" };

export function resolveCronCreateSchedule(options: ScheduleOptionInput): CronSchedule {
  const normalized = normalizeScheduleOptions(options);
  const chosen = countChosenSchedules(normalized);
  if (chosen !== 1) {
    throw new Error("Choose exactly one schedule: --at, --every, or --cron");
  }
  const schedule = resolveDirectSchedule(normalized);
  if (!schedule) {
    throw new Error("Choose exactly one schedule: --at, --every, or --cron");
  }
  return schedule;
}

export function resolveCronEditScheduleRequest(
  options: ScheduleOptionInput,
): CronEditScheduleRequest {
  const normalized = normalizeScheduleOptions(options);
  const chosen = countChosenSchedules(normalized);
  if (chosen > 1) {
    throw new Error("Choose at most one schedule change");
  }
  const schedule = resolveDirectSchedule(normalized);
  if (schedule) {
    return { kind: "direct", schedule };
  }
  if (normalized.requestedStaggerMs !== undefined || normalized.tz !== undefined) {
    return {
      kind: "patch-existing-cron",
      staggerMs: normalized.requestedStaggerMs,
      tz: normalized.tz,
    };
  }
  return { kind: "none" };
}

export function applyExistingCronSchedulePatch(
  existingSchedule: CronSchedule,
  request: Extract<CronEditScheduleRequest, { kind: "patch-existing-cron" }>,
): CronSchedule {
  if (existingSchedule.kind !== "cron") {
    throw new Error("Current job is not a cron schedule; use --cron to convert first");
  }
  return {
    expr: existingSchedule.expr,
    kind: "cron",
    staggerMs: request.staggerMs !== undefined ? request.staggerMs : existingSchedule.staggerMs,
    tz: request.tz ?? existingSchedule.tz,
  };
}

function normalizeScheduleOptions(options: ScheduleOptionInput): NormalizedScheduleOptions {
  const staggerRaw = normalizeOptionalString(options.stagger) ?? "";
  const useExact = Boolean(options.exact);
  if (staggerRaw && useExact) {
    throw new Error("Choose either --stagger or --exact, not both");
  }
  return {
    at: normalizeOptionalString(options.at) ?? "",
    cronExpr: normalizeOptionalString(options.cron) ?? "",
    every: normalizeOptionalString(options.every) ?? "",
    requestedStaggerMs: parseCronStaggerMs({ staggerRaw, useExact }),
    tz: normalizeOptionalString(options.tz),
  };
}

function countChosenSchedules(options: NormalizedScheduleOptions): number {
  return [Boolean(options.at), Boolean(options.every), Boolean(options.cronExpr)].filter(Boolean)
    .length;
}

function resolveDirectSchedule(options: NormalizedScheduleOptions): CronSchedule | undefined {
  if (options.tz && options.every) {
    throw new Error("--tz is only valid with --cron or offset-less --at");
  }
  if (options.requestedStaggerMs !== undefined && (options.at || options.every)) {
    throw new Error("--stagger/--exact are only valid for cron schedules");
  }
  if (options.at) {
    const atIso = parseAt(options.at, options.tz);
    if (!atIso) {
      throw new Error("Invalid --at; use ISO time or duration like 20m");
    }
    return { at: atIso, kind: "at" };
  }
  if (options.every) {
    const everyMs = parseDurationMs(options.every);
    if (!everyMs) {
      throw new Error("Invalid --every; use e.g. 10m, 1h, 1d");
    }
    return { everyMs, kind: "every" };
  }
  if (options.cronExpr) {
    return {
      expr: options.cronExpr,
      kind: "cron",
      staggerMs: options.requestedStaggerMs,
      tz: options.tz,
    };
  }
  return undefined;
}
