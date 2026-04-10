import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { isWindowsDrivePath } from "../infra/archive-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { writeFileFromPathWithinRoot } from "../infra/fs-safe.js";
import { assertCanonicalPathWithinBase } from "../infra/install-safe-path.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isWithinDir } from "../infra/path-safety.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { extractArchive } from "./skills-install-extract.js";
import { formatInstallFailureMessage } from "./skills-install-output.js";
import type { SkillInstallResult } from "./skills-install.types.js";
import type { SkillEntry, SkillInstallSpec } from "./skills.js";
import { resolveSkillToolsRootDir } from "./skills/tools-dir.js";

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string {
  const safeRoot = resolveSkillToolsRootDir(entry);
  const raw = spec.targetDir?.trim();
  if (!raw) {
    return safeRoot;
  }

  // Treat non-absolute paths as relative to the per-skill tools root.
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw)
      ? resolveUserPath(raw)
      : path.resolve(safeRoot, raw);

  if (!isWithinDir(safeRoot, resolved)) {
    throw new Error(
      `Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${safeRoot}".`,
    );
  }
  return resolved;
}

function resolveArchiveType(spec: SkillInstallSpec, filename: string): string | undefined {
  const explicit = normalizeOptionalLowercaseString(spec.archive);
  if (explicit) {
    return explicit;
  }
  const lower = normalizeOptionalLowercaseString(filename);
  if (!lower) {
    return undefined;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
    return "tar.bz2";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

async function downloadFile(params: {
  url: string;
  rootDir: string;
  relativePath: string;
  timeoutMs: number;
}): Promise<{ bytes: number }> {
  const destPath = path.resolve(params.rootDir, params.relativePath);
  const stagingDir = path.join(params.rootDir, ".openclaw-download-staging");
  await ensureDir(stagingDir);
  await assertCanonicalPathWithinBase({
    baseDir: params.rootDir,
    boundaryLabel: "skill tools directory",
    candidatePath: stagingDir,
  });
  const tempPath = path.join(stagingDir, `${randomUUID()}.tmp`);
  const { response, release } = await fetchWithSsrFGuard({
    timeoutMs: Math.max(1000, params.timeoutMs),
    url: params.url,
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    const file = fs.createWriteStream(tempPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    await pipeline(readable, file);
    await writeFileFromPathWithinRoot({
      relativePath: params.relativePath,
      rootDir: params.rootDir,
      sourcePath: tempPath,
    });
    const stat = await fs.promises.stat(destPath);
    return { bytes: stat.size };
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    await release();
  }
}

export async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const safeRoot = resolveSkillToolsRootDir(entry);
  const url = spec.url?.trim();
  if (!url) {
    return {
      code: null,
      message: "missing download url",
      ok: false,
      stderr: "",
      stdout: "",
    };
  }

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  let canonicalSafeRoot = "";
  let targetDir = "";
  try {
    await ensureDir(safeRoot);
    await assertCanonicalPathWithinBase({
      baseDir: safeRoot,
      boundaryLabel: "skill tools directory",
      candidatePath: safeRoot,
    });
    canonicalSafeRoot = await fs.promises.realpath(safeRoot);

    const requestedTargetDir = resolveDownloadTargetDir(entry, spec);
    await ensureDir(requestedTargetDir);
    await assertCanonicalPathWithinBase({
      baseDir: safeRoot,
      boundaryLabel: "skill tools directory",
      candidatePath: requestedTargetDir,
    });
    const targetRelativePath = path.relative(safeRoot, requestedTargetDir);
    targetDir = path.join(canonicalSafeRoot, targetRelativePath);
  } catch (error) {
    const message = formatErrorMessage(error);
    return { code: null, message, ok: false, stderr: message, stdout: "" };
  }

  const archivePath = path.join(targetDir, filename);
  const archiveRelativePath = path.relative(canonicalSafeRoot, archivePath);
  if (
    !archiveRelativePath ||
    archiveRelativePath === ".." ||
    archiveRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archiveRelativePath)
  ) {
    return {
      code: null,
      message: "invalid download archive path",
      ok: false,
      stderr: "invalid download archive path",
      stdout: "",
    };
  }
  let downloaded = 0;
  try {
    const result = await downloadFile({
      relativePath: archiveRelativePath,
      rootDir: canonicalSafeRoot,
      timeoutMs,
      url,
    });
    downloaded = result.bytes;
  } catch (error) {
    const message = formatErrorMessage(error);
    return { code: null, message, ok: false, stderr: message, stdout: "" };
  }

  const archiveType = resolveArchiveType(spec, filename);
  const shouldExtract = spec.extract ?? Boolean(archiveType);
  if (!shouldExtract) {
    return {
      code: 0,
      message: `Downloaded to ${archivePath}`,
      ok: true,
      stderr: "",
      stdout: `downloaded=${downloaded}`,
    };
  }

  if (!archiveType) {
    return {
      code: null,
      message: "extract requested but archive type could not be detected",
      ok: false,
      stderr: "",
      stdout: "",
    };
  }

  try {
    await assertCanonicalPathWithinBase({
      baseDir: canonicalSafeRoot,
      boundaryLabel: "skill tools directory",
      candidatePath: targetDir,
    });
  } catch (error) {
    const message = formatErrorMessage(error);
    return { code: null, message, ok: false, stderr: message, stdout: "" };
  }

  const extractResult = await extractArchive({
    archivePath,
    archiveType,
    stripComponents: spec.stripComponents,
    targetDir,
    timeoutMs,
  });
  const success = extractResult.code === 0;
  return {
    code: extractResult.code,
    message: success
      ? `Downloaded and extracted to ${targetDir}`
      : formatInstallFailureMessage(extractResult),
    ok: success,
    stderr: extractResult.stderr.trim(),
    stdout: extractResult.stdout.trim(),
  };
}
