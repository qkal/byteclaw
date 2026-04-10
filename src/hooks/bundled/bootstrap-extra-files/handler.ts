import {
  filterBootstrapFilesForSession,
  loadExtraBootstrapFilesWithDiagnostics,
} from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { normalizeTrimmedStringList } from "../../../shared/string-normalization.js";
import { resolveHookConfig } from "../../config.js";
import { type HookHandler, isAgentBootstrapEvent } from "../../hooks.js";

const HOOK_KEY = "bootstrap-extra-files";
const log = createSubsystemLogger("bootstrap-extra-files");

function resolveExtraBootstrapPatterns(hookConfig: Record<string, unknown>): string[] {
  const fromPaths = normalizeTrimmedStringList(hookConfig.paths);
  if (fromPaths.length > 0) {
    return fromPaths;
  }
  const fromPatterns = normalizeTrimmedStringList(hookConfig.patterns);
  if (fromPatterns.length > 0) {
    return fromPatterns;
  }
  return normalizeTrimmedStringList(hookConfig.files);
}

const bootstrapExtraFilesHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const { context } = event;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const patterns = resolveExtraBootstrapPatterns(hookConfig as Record<string, unknown>);
  if (patterns.length === 0) {
    return;
  }

  try {
    const { files: extras, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      patterns,
    );
    if (diagnostics.length > 0) {
      log.debug("skipped extra bootstrap candidates", {
        reasons: diagnostics.reduce<Record<string, number>>((counts, item) => {
          counts[item.reason] = (counts[item.reason] ?? 0) + 1;
          return counts;
        }, {}),
        skipped: diagnostics.length,
      });
    }
    if (extras.length === 0) {
      return;
    }
    context.bootstrapFiles = filterBootstrapFilesForSession(
      [...context.bootstrapFiles, ...extras],
      context.sessionKey,
    );
  } catch (error) {
    log.warn(`failed: ${String(error)}`);
  }
};

export default bootstrapExtraFilesHook;
