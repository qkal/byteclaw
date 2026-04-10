import type { OpenClawConfig } from "../config/config.js";
import {
  expectedIntegrityForUpdate,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import {
  type HookNpmIntegrityDriftParams,
  installHooksFromNpmSpec,
  resolveHookInstallDir,
} from "./install.js";
import { recordHookInstall } from "./installs.js";

export interface HookPackUpdateLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export type HookPackUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export interface HookPackUpdateOutcome {
  hookId: string;
  status: HookPackUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
}

export interface HookPackUpdateSummary {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: HookPackUpdateOutcome[];
}

export type HookPackUpdateIntegrityDriftParams = HookNpmIntegrityDriftParams & {
  hookId: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  dryRun: boolean;
};

function createHookPackUpdateIntegrityDriftHandler(params: {
  hookId: string;
  dryRun: boolean;
  logger: HookPackUpdateLogger;
  onIntegrityDrift?: (params: HookPackUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: HookNpmIntegrityDriftParams) => {
    const payload: HookPackUpdateIntegrityDriftParams = {
      actualIntegrity: drift.actualIntegrity,
      dryRun: params.dryRun,
      expectedIntegrity: drift.expectedIntegrity,
      hookId: params.hookId,
      resolution: drift.resolution,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      spec: drift.spec,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for hook pack "${params.hookId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return true;
  };
}

export async function updateNpmInstalledHookPacks(params: {
  config: OpenClawConfig;
  logger?: HookPackUpdateLogger;
  hookIds?: string[];
  dryRun?: boolean;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: HookPackUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<HookPackUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.hooks?.internal?.installs ?? {};
  const targets = params.hookIds?.length ? params.hookIds : Object.keys(installs);
  const outcomes: HookPackUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;

  for (const hookId of targets) {
    const record = installs[hookId];
    if (!record) {
      outcomes.push({
        hookId,
        message: `No install record for hook pack "${hookId}".`,
        status: "skipped",
      });
      continue;
    }
    if (record.source !== "npm") {
      outcomes.push({
        hookId,
        message: `Skipping hook pack "${hookId}" (source: ${record.source}).`,
        status: "skipped",
      });
      continue;
    }

    const effectiveSpec = params.specOverrides?.[hookId] ?? record.spec;
    const expectedIntegrity =
      effectiveSpec === record.spec
        ? expectedIntegrityForUpdate(record.spec, record.integrity)
        : undefined;
    if (!effectiveSpec) {
      outcomes.push({
        hookId,
        message: `Skipping hook pack "${hookId}" (missing npm spec).`,
        status: "skipped",
      });
      continue;
    }

    let installPath: string;
    try {
      installPath = record.installPath ?? resolveHookInstallDir(hookId);
    } catch (error) {
      outcomes.push({
        hookId,
        message: `Invalid install path for hook pack "${hookId}": ${String(error)}`,
        status: "error",
      });
      continue;
    }
    const currentVersion = await readInstalledPackageVersion(installPath);
    const result = await installHooksFromNpmSpec({
      dryRun: params.dryRun,
      expectedHookPackId: hookId,
      expectedIntegrity,
      logger,
      mode: "update",
      onIntegrityDrift: createHookPackUpdateIntegrityDriftHandler({
        dryRun: Boolean(params.dryRun),
        hookId,
        logger,
        onIntegrityDrift: params.onIntegrityDrift,
      }),
      spec: effectiveSpec,
    });

    if (!result.ok) {
      outcomes.push({
        hookId,
        message: `Failed to ${params.dryRun ? "check" : "update"} hook pack "${hookId}": ${result.error}`,
        status: "error",
      });
      continue;
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";
    const status =
      currentVersion && nextVersion && currentVersion === nextVersion ? "unchanged" : "updated";

    if (params.dryRun) {
      outcomes.push({
        currentVersion: currentVersion ?? undefined,
        hookId,
        message:
          status === "unchanged"
            ? `Hook pack "${hookId}" is up to date (${currentLabel}).`
            : `Would update hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
        nextVersion: nextVersion ?? undefined,
        status,
      });
      continue;
    }

    next = recordHookInstall(next, {
      hookId,
      hooks: result.hooks,
      installPath: result.targetDir,
      integrity: result.npmResolution?.integrity,
      resolvedName: result.npmResolution?.name,
      resolvedSpec: result.npmResolution?.resolvedSpec,
      source: "npm",
      spec: effectiveSpec,
      version: nextVersion,
    });
    changed = true;

    outcomes.push({
      currentVersion: currentVersion ?? undefined,
      hookId,
      message:
        status === "unchanged"
          ? `Hook pack "${hookId}" already at ${currentLabel}.`
          : `Updated hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
      nextVersion: nextVersion ?? undefined,
      status,
    });
  }

  return { changed, config: next, outcomes };
}
