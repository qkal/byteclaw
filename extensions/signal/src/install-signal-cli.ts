import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { CONFIG_DIR, extractArchive, resolveBrewExecutable } from "openclaw/plugin-sdk/setup-tools";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface NamedAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseResponse {
  tag_name?: string;
  assets?: ReleaseAsset[];
}

export interface SignalInstallResult {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
}

/** @internal Exported for testing. */
export async function extractSignalCliArchive(
  archivePath: string,
  installRoot: string,
  timeoutMs: number,
): Promise<void> {
  await extractArchive({ archivePath, destDir: installRoot, timeoutMs });
}

/** @internal Exported for testing. */
export function looksLikeArchive(name: string): boolean {
  return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
}

/**
 * Pick a native release asset from the official GitHub releases.
 *
 * The official signal-cli releases only publish native (GraalVM) binaries for
 * x86-64 Linux.  On architectures where no native asset is available this
 * returns `undefined` so the caller can fall back to a different install
 * strategy (e.g. Homebrew).
 */
/** @internal Exported for testing. */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): NamedAsset | undefined {
  const withName = assets.filter((asset): asset is NamedAsset =>
    Boolean(asset.name && asset.browser_download_url),
  );

  // Archives only, excluding signature files (.asc)
  const archives = withName.filter((a) =>
    looksLikeArchive(normalizeLowercaseStringOrEmpty(a.name)),
  );

  const byName = (pattern: RegExp) =>
    archives.find((asset) => pattern.test(normalizeLowercaseStringOrEmpty(asset.name)));

  if (platform === "linux") {
    // The official "Linux-native" asset is an x86-64 GraalVM binary.
    // On non-x64 architectures it will fail with "Exec format error",
    // So only select it when the host architecture matches.
    if (arch === "x64") {
      return byName(/linux-native/) || byName(/linux/) || archives[0];
    }
    // No native release for this arch — caller should fall back.
    return undefined;
  }

  if (platform === "darwin") {
    return byName(/macos|osx|darwin/) || archives[0];
  }

  if (platform === "win32") {
    return byName(/windows|win/) || archives[0];
  }

  return archives[0];
}

async function downloadToFile(url: string, dest: string, maxRedirects = 5): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const {location} = res.headers;
        if (!location || maxRedirects <= 0) {
          reject(new Error("Redirect loop or missing Location header"));
          return;
        }
        const redirectUrl = new URL(location, url).href;
        resolve(downloadToFile(redirectUrl, dest, maxRedirects - 1));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading file`));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(resolve).catch(reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function findSignalCliBinary(root: string): Promise<string | null> {
  const candidates: string[] = [];
  const enqueue = async (dir: string, depth: number) => {
    if (depth > 3) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await enqueue(full, depth + 1);
      } else if (entry.isFile() && entry.name === "signal-cli") {
        candidates.push(full);
      }
    }
  };
  await enqueue(root, 0);
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Brew-based install (used on architectures without an official native build)
// ---------------------------------------------------------------------------

async function resolveBrewSignalCliPath(brewExe: string): Promise<string | null> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: [brewExe, "--prefix", "signal-cli"],
      timeoutMs: 10_000,
    });
    if (result.code === 0 && result.stdout.trim()) {
      const prefix = result.stdout.trim();
      // Homebrew installs the wrapper script at <prefix>/bin/signal-cli
      const candidate = path.join(prefix, "bin", "signal-cli");
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Fall back to searching the prefix
        return findSignalCliBinary(prefix);
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

async function installSignalCliViaBrew(runtime: RuntimeEnv): Promise<SignalInstallResult> {
  const brewExe = resolveBrewExecutable();
  if (!brewExe) {
    return {
      error:
        `No native signal-cli build is available for ${process.arch}. ` +
        "Install Homebrew (https://brew.sh) and try again, or install signal-cli manually.",
      ok: false,
    };
  }

  runtime.log(`Installing signal-cli via Homebrew (${brewExe})…`);
  const result = await runPluginCommandWithTimeout({
    argv: [brewExe, "install", "signal-cli"],
    timeoutMs: 15 * 60_000, // Brew builds from source; can take a while
  });

  if (result.code !== 0) {
    return {
      error: `brew install signal-cli failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`,
      ok: false,
    };
  }

  const cliPath = await resolveBrewSignalCliPath(brewExe);
  if (!cliPath) {
    return {
      error: "brew install succeeded but signal-cli binary was not found.",
      ok: false,
    };
  }

  // Extract version from the installed binary.
  let version: string | undefined;
  try {
    const vResult = await runPluginCommandWithTimeout({
      argv: [cliPath, "--version"],
      timeoutMs: 10_000,
    });
    // Output is typically "signal-cli 0.13.24"
    version = vResult.stdout.trim().replace(/^signal-cli\s+/, "") || undefined;
  } catch {
    // Non-critical; leave version undefined
  }

  return { cliPath, ok: true, version };
}

// ---------------------------------------------------------------------------
// Direct download install (used when an official native asset is available)
// ---------------------------------------------------------------------------

async function installSignalCliFromRelease(runtime: RuntimeEnv): Promise<SignalInstallResult> {
  const apiUrl = "https://api.github.com/repos/AsamK/signal-cli/releases/latest";
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw",
    },
  });

  if (!response.ok) {
    return {
      error: `Failed to fetch release info (${response.status})`,
      ok: false,
    };
  }

  const payload = (await response.json()) as ReleaseResponse;
  const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
  const assets = payload.assets ?? [];
  const asset = pickAsset(assets, process.platform, process.arch);

  if (!asset) {
    return {
      error: "No compatible release asset found for this platform.",
      ok: false,
    };
  }

  const tmpDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-signal-"));
  const archivePath = path.join(tmpDir, asset.name);

  runtime.log(`Downloading signal-cli ${version} (${asset.name})…`);
  await downloadToFile(asset.browser_download_url, archivePath);

  const installRoot = path.join(CONFIG_DIR, "tools", "signal-cli", version);
  await fs.mkdir(installRoot, { recursive: true });

  if (!looksLikeArchive(normalizeLowercaseStringOrEmpty(asset.name))) {
    return { error: `Unsupported archive type: ${asset.name}`, ok: false };
  }
  try {
    await extractSignalCliArchive(archivePath, installRoot, 60_000);
  } catch (error) {
    const message = formatErrorMessage(error);
    return {
      error: `Failed to extract ${asset.name}: ${message}`,
      ok: false,
    };
  }

  const cliPath = await findSignalCliBinary(installRoot);
  if (!cliPath) {
    return {
      error: `signal-cli binary not found after extracting ${asset.name}`,
      ok: false,
    };
  }

  await fs.chmod(cliPath, 0o755).catch(() => {});

  return { cliPath, ok: true, version };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function installSignalCli(runtime: RuntimeEnv): Promise<SignalInstallResult> {
  if (process.platform === "win32") {
    return {
      error: "Signal CLI auto-install is not supported on Windows yet.",
      ok: false,
    };
  }

  // The official signal-cli GitHub releases only ship a native binary for
  // X86-64 Linux.  On other architectures (arm64, armv7, etc.) we delegate
  // To Homebrew which builds from source and bundles the JRE automatically.
  const hasNativeRelease = process.platform !== "linux" || process.arch === "x64";

  if (hasNativeRelease) {
    return installSignalCliFromRelease(runtime);
  }

  return installSignalCliViaBrew(runtime);
}
