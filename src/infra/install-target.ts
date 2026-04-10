import fs from "node:fs/promises";
import { fileExists } from "./archive.js";
import { formatErrorMessage } from "./errors.js";
import { assertCanonicalPathWithinBase, resolveSafeInstallDir } from "./install-safe-path.js";

export async function resolveCanonicalInstallTarget(params: {
  baseDir: string;
  id: string;
  invalidNameMessage: string;
  boundaryLabel: string;
  nameEncoder?: (id: string) => string;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  await fs.mkdir(params.baseDir, { recursive: true });
  const targetDirResult = resolveSafeInstallDir({
    baseDir: params.baseDir,
    id: params.id,
    invalidNameMessage: params.invalidNameMessage,
    nameEncoder: params.nameEncoder,
  });
  if (!targetDirResult.ok) {
    return { error: targetDirResult.error, ok: false };
  }
  try {
    await assertCanonicalPathWithinBase({
      baseDir: params.baseDir,
      boundaryLabel: params.boundaryLabel,
      candidatePath: targetDirResult.path,
    });
  } catch (error) {
    return { error: formatErrorMessage(error), ok: false };
  }
  return { ok: true, targetDir: targetDirResult.path };
}

export async function ensureInstallTargetAvailable(params: {
  mode: "install" | "update";
  targetDir: string;
  alreadyExistsError: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.mode === "install" && (await fileExists(params.targetDir))) {
    return { error: params.alreadyExistsError, ok: false };
  }
  return { ok: true };
}
