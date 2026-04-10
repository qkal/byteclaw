import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  createTarEntryPreflightChecker,
  extractArchive as extractArchiveSafe,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  withStagedArchiveDestination,
} from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { parseTarVerboseMetadata } from "./skills-install-tar-verbose.js";
import { hasBinary } from "./skills.js";

export interface ArchiveExtractResult { stdout: string; stderr: string; code: number | null }
interface TarPreflightResult {
  entries: string[];
  metadata: ReturnType<typeof parseTarVerboseMetadata>;
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => {
      hash.update(chunk as Buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

function commandFailureResult(
  result: { stdout: string; stderr: string; code: number | null },
  fallbackStderr: string,
): ArchiveExtractResult {
  return {
    code: result.code,
    stderr: result.stderr || fallbackStderr,
    stdout: result.stdout,
  };
}

function buildTarExtractArgv(params: {
  archivePath: string;
  targetDir: string;
  stripComponents: number;
}): string[] {
  const argv = ["tar", "xf", params.archivePath, "-C", params.targetDir];
  if (params.stripComponents > 0) {
    argv.push("--strip-components", String(params.stripComponents));
  }
  return argv;
}

async function readTarPreflight(params: {
  archivePath: string;
  timeoutMs: number;
}): Promise<TarPreflightResult | ArchiveExtractResult> {
  const listResult = await runCommandWithTimeout(["tar", "tf", params.archivePath], {
    timeoutMs: params.timeoutMs,
  });
  if (listResult.code !== 0) {
    return commandFailureResult(listResult, "tar list failed");
  }
  const entries = listResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const verboseResult = await runCommandWithTimeout(["tar", "tvf", params.archivePath], {
    timeoutMs: params.timeoutMs,
  });
  if (verboseResult.code !== 0) {
    return commandFailureResult(verboseResult, "tar verbose list failed");
  }
  const metadata = parseTarVerboseMetadata(verboseResult.stdout);
  if (metadata.length !== entries.length) {
    return {
      code: 1,
      stderr: `tar verbose/list entry count mismatch (${metadata.length} vs ${entries.length})`,
      stdout: verboseResult.stdout,
    };
  }
  return { entries, metadata };
}

function isArchiveExtractFailure(
  value: TarPreflightResult | ArchiveExtractResult,
): value is ArchiveExtractResult {
  return "code" in value;
}

async function verifyArchiveHashStable(params: {
  archivePath: string;
  expectedHash: string;
}): Promise<ArchiveExtractResult | null> {
  const postPreflightHash = await hashFileSha256(params.archivePath);
  if (postPreflightHash === params.expectedHash) {
    return null;
  }
  return {
    code: 1,
    stderr: "tar archive changed during safety preflight; refusing to extract",
    stdout: "",
  };
}

async function extractTarBz2WithStaging(params: {
  archivePath: string;
  destinationRealDir: string;
  stripComponents: number;
  timeoutMs: number;
}): Promise<ArchiveExtractResult> {
  return await withStagedArchiveDestination({
    destinationRealDir: params.destinationRealDir,
    run: async (stagingDir) => {
      const extractResult = await runCommandWithTimeout(
        buildTarExtractArgv({
          archivePath: params.archivePath,
          stripComponents: params.stripComponents,
          targetDir: stagingDir,
        }),
        { timeoutMs: params.timeoutMs },
      );
      if (extractResult.code !== 0) {
        return extractResult;
      }
      await mergeExtractedTreeIntoDestination({
        destinationDir: params.destinationRealDir,
        destinationRealDir: params.destinationRealDir,
        sourceDir: stagingDir,
      });
      return extractResult;
    },
  });
}

export async function extractArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<ArchiveExtractResult> {
  const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
  const strip =
    typeof stripComponents === "number" && Number.isFinite(stripComponents)
      ? Math.max(0, Math.floor(stripComponents))
      : 0;

  try {
    if (archiveType === "zip") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        kind: "zip",
        stripComponents: strip,
        timeoutMs,
      });
      return { code: 0, stderr: "", stdout: "" };
    }

    if (archiveType === "tar.gz") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        kind: "tar",
        stripComponents: strip,
        tarGzip: true,
        timeoutMs,
      });
      return { code: 0, stderr: "", stdout: "" };
    }

    if (archiveType === "tar.bz2") {
      if (!hasBinary("tar")) {
        return { code: null, stderr: "tar not found on PATH", stdout: "" };
      }

      const destinationRealDir = await prepareArchiveDestinationDir(targetDir);
      const preflightHash = await hashFileSha256(archivePath);

      // Preflight list to prevent zip-slip style traversal before extraction.
      const preflight = await readTarPreflight({ archivePath, timeoutMs });
      if (isArchiveExtractFailure(preflight)) {
        return preflight;
      }
      const checkTarEntrySafety = createTarEntryPreflightChecker({
        escapeLabel: "targetDir",
        rootDir: destinationRealDir,
        stripComponents: strip,
      });
      for (let i = 0; i < preflight.entries.length; i += 1) {
        const entryPath = preflight.entries[i];
        const entryMeta = preflight.metadata[i];
        if (!entryPath || !entryMeta) {
          return {
            code: 1,
            stderr: "tar metadata parse failure",
            stdout: "",
          };
        }
        checkTarEntrySafety({
          path: entryPath,
          size: entryMeta.size,
          type: entryMeta.type,
        });
      }

      const hashFailure = await verifyArchiveHashStable({
        archivePath,
        expectedHash: preflightHash,
      });
      if (hashFailure) {
        return hashFailure;
      }

      return await extractTarBz2WithStaging({
        archivePath,
        destinationRealDir,
        stripComponents: strip,
        timeoutMs,
      });
    }

    return { code: null, stderr: `unsupported archive type: ${archiveType}`, stdout: "" };
  } catch (error) {
    const message = formatErrorMessage(error);
    return { code: 1, stderr: message, stdout: "" };
  }
}
