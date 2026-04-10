import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { compareComparableSemver, parseComparableSemver } from "./semver-compare.js";
import { type UpdateChannel, channelToNpmTag } from "./update-channels.js";

export type PackageManager = "pnpm" | "bun" | "npm" | "unknown";

export interface GitUpdateStatus {
  root: string;
  sha: string | null;
  tag: string | null;
  branch: string | null;
  upstream: string | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  fetchOk: boolean | null;
  error?: string;
}

export interface DepsStatus {
  manager: PackageManager;
  status: "ok" | "missing" | "stale" | "unknown";
  lockfilePath: string | null;
  markerPath: string | null;
  reason?: string;
}

export interface RegistryStatus {
  latestVersion: string | null;
  error?: string;
}

export interface NpmTagStatus {
  tag: string;
  version: string | null;
  error?: string;
}

export interface NpmPackageTargetStatus {
  target: string;
  version: string | null;
  nodeEngine: string | null;
  error?: string;
}

export interface UpdateCheckResult {
  root: string | null;
  installKind: "git" | "package" | "unknown";
  packageManager: PackageManager;
  git?: GitUpdateStatus;
  deps?: DepsStatus;
  registry?: RegistryStatus;
}

export function formatGitInstallLabel(update: UpdateCheckResult): string | null {
  if (update.installKind !== "git") {
    return null;
  }
  const shortSha = update.git?.sha ? update.git.sha.slice(0, 8) : null;
  const branch = update.git?.branch && update.git.branch !== "HEAD" ? update.git.branch : null;
  const tag = update.git?.tag ?? null;
  const parts = [
    branch ?? (tag ? "detached" : "git"),
    tag ? `tag ${tag}` : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  return (await detectPackageManagerImpl(root)) ?? "unknown";
}

async function detectGitRoot(root: string): Promise<string | null> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 4000,
  }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const top = res.stdout.trim();
  return top ? path.resolve(top) : null;
}

export async function checkGitUpdateStatus(params: {
  root: string;
  timeoutMs?: number;
  fetch?: boolean;
}): Promise<GitUpdateStatus> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = path.resolve(params.root);

  const base: GitUpdateStatus = {
    ahead: null,
    behind: null,
    branch: null,
    dirty: null,
    fetchOk: null,
    root,
    sha: null,
    tag: null,
    upstream: null,
  };

  const [branchRes, shaRes, tagRes, upstreamRes, dirtyRes] = await Promise.all([
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "describe", "--tags", "--exact-match"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "--abbrev-ref", "@{upstream}"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(
      ["git", "-C", root, "status", "--porcelain", "--", ":!dist/control-ui/"],
      {
        timeoutMs,
      },
    ).catch(() => null),
  ]);
  if (!branchRes || branchRes.code !== 0) {
    return { ...base, error: branchRes?.stderr?.trim() || "git unavailable" };
  }
  const branch = branchRes.stdout.trim() || null;

  const sha = shaRes && shaRes.code === 0 ? shaRes.stdout.trim() : null;

  const tag = tagRes && tagRes.code === 0 ? tagRes.stdout.trim() : null;

  const upstream = upstreamRes && upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null;

  const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;

  const fetchOk = params.fetch
    ? await runCommandWithTimeout(["git", "-C", root, "fetch", "--quiet", "--prune"], { timeoutMs })
        .then((r) => r.code === 0)
        .catch(() => false)
    : null;

  const counts =
    upstream && upstream.length > 0
      ? await runCommandWithTimeout(
          ["git", "-C", root, "rev-list", "--left-right", "--count", `HEAD...${upstream}`],
          { timeoutMs },
        ).catch(() => null)
      : null;

  const parseCounts = (raw: string): { ahead: number; behind: number } | null => {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }
    const ahead = Number.parseInt(parts[0] ?? "", 10);
    const behind = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return null;
    }
    return { ahead, behind };
  };
  const parsed = counts && counts.code === 0 ? parseCounts(counts.stdout) : null;

  return {
    ahead: parsed?.ahead ?? null,
    behind: parsed?.behind ?? null,
    branch,
    dirty,
    fetchOk,
    root,
    sha,
    tag,
    upstream,
  };
}

async function statMtimeMs(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function resolveDepsMarker(params: { root: string; manager: PackageManager }): {
  lockfilePath: string | null;
  markerPath: string | null;
} {
  const {root} = params;
  if (params.manager === "pnpm") {
    return {
      lockfilePath: path.join(root, "pnpm-lock.yaml"),
      markerPath: path.join(root, "node_modules", ".modules.yaml"),
    };
  }
  if (params.manager === "bun") {
    return {
      lockfilePath: path.join(root, "bun.lockb"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  if (params.manager === "npm") {
    return {
      lockfilePath: path.join(root, "package-lock.json"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  return { lockfilePath: null, markerPath: null };
}

export async function checkDepsStatus(params: {
  root: string;
  manager: PackageManager;
}): Promise<DepsStatus> {
  const root = path.resolve(params.root);
  const { lockfilePath, markerPath } = resolveDepsMarker({
    manager: params.manager,
    root,
  });

  if (!lockfilePath || !markerPath) {
    return {
      lockfilePath,
      manager: params.manager,
      markerPath,
      reason: "unknown package manager",
      status: "unknown",
    };
  }

  const lockExists = await exists(lockfilePath);
  const markerExists = await exists(markerPath);
  if (!lockExists) {
    return {
      lockfilePath,
      manager: params.manager,
      markerPath,
      reason: "lockfile missing",
      status: "unknown",
    };
  }
  if (!markerExists) {
    return {
      lockfilePath,
      manager: params.manager,
      markerPath,
      reason: "node_modules marker missing",
      status: "missing",
    };
  }

  const lockMtime = await statMtimeMs(lockfilePath);
  const markerMtime = await statMtimeMs(markerPath);
  if (!lockMtime || !markerMtime) {
    return {
      lockfilePath,
      manager: params.manager,
      markerPath,
      status: "unknown",
    };
  }
  if (lockMtime > markerMtime + 1000) {
    return {
      lockfilePath,
      manager: params.manager,
      markerPath,
      reason: "lockfile newer than install marker",
      status: "stale",
    };
  }
  return {
    lockfilePath,
    manager: params.manager,
    markerPath,
    status: "ok",
  };
}

export async function fetchNpmLatestVersion(params?: {
  timeoutMs?: number;
}): Promise<RegistryStatus> {
  const res = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params?.timeoutMs });
  return {
    error: res.error,
    latestVersion: res.version,
  };
}

export async function fetchNpmPackageTargetStatus(params: {
  target: string;
  timeoutMs?: number;
}): Promise<NpmPackageTargetStatus> {
  const timeoutMs = params.timeoutMs ?? 3500;
  const {target} = params;
  try {
    const res = await fetchWithTimeout(
      `https://registry.npmjs.org/openclaw/${encodeURIComponent(target)}`,
      {},
      Math.max(250, timeoutMs),
    );
    if (!res.ok) {
      return { error: `HTTP ${res.status}`, nodeEngine: null, target, version: null };
    }
    const json = (await res.json()) as {
      version?: unknown;
      engines?: { node?: unknown };
    };
    const version = typeof json?.version === "string" ? json.version : null;
    const nodeEngine = typeof json?.engines?.node === "string" ? json.engines.node : null;
    return { nodeEngine, target, version };
  } catch (error) {
    return { error: String(error), nodeEngine: null, target, version: null };
  }
}

export async function fetchNpmTagVersion(params: {
  tag: string;
  timeoutMs?: number;
}): Promise<NpmTagStatus> {
  const res = await fetchNpmPackageTargetStatus({
    target: params.tag,
    timeoutMs: params.timeoutMs,
  });
  return {
    error: res.error,
    tag: params.tag,
    version: res.version,
  };
}

export async function resolveNpmChannelTag(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
}): Promise<{ tag: string; version: string | null }> {
  const channelTag = channelToNpmTag(params.channel);
  const channelStatus = await fetchNpmTagVersion({ tag: channelTag, timeoutMs: params.timeoutMs });
  if (params.channel !== "beta") {
    return { tag: channelTag, version: channelStatus.version };
  }

  const latestStatus = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params.timeoutMs });
  if (!latestStatus.version) {
    return { tag: channelTag, version: channelStatus.version };
  }
  if (!channelStatus.version) {
    return { tag: "latest", version: latestStatus.version };
  }
  const cmp = compareSemverStrings(channelStatus.version, latestStatus.version);
  if (cmp != null && cmp < 0) {
    return { tag: "latest", version: latestStatus.version };
  }
  return { tag: channelTag, version: channelStatus.version };
}

export function compareSemverStrings(a: string | null, b: string | null): number | null {
  return compareComparableSemver(
    parseComparableSemver(a, { normalizeLegacyDotBeta: true }),
    parseComparableSemver(b, { normalizeLegacyDotBeta: true }),
  );
}

export async function checkUpdateStatus(params: {
  root: string | null;
  timeoutMs?: number;
  fetchGit?: boolean;
  includeRegistry?: boolean;
}): Promise<UpdateCheckResult> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = params.root ? path.resolve(params.root) : null;
  if (!root) {
    return {
      installKind: "unknown",
      packageManager: "unknown",
      registry: params.includeRegistry ? await fetchNpmLatestVersion({ timeoutMs }) : undefined,
      root: null,
    };
  }

  const [pm, gitRoot, registry] = await Promise.all([
    detectPackageManager(root),
    detectGitRoot(root),
    params.includeRegistry ? fetchNpmLatestVersion({ timeoutMs }) : Promise.resolve(undefined),
  ]);
  const isGit = gitRoot && path.resolve(gitRoot) === root;

  const installKind: UpdateCheckResult["installKind"] = isGit ? "git" : "package";
  const [git, deps] = await Promise.all([
    isGit
      ? checkGitUpdateStatus({
          fetch: Boolean(params.fetchGit),
          root,
          timeoutMs,
        })
      : Promise.resolve(undefined),
    checkDepsStatus({ manager: pm, root }),
  ]);

  return {
    deps,
    git,
    installKind,
    packageManager: pm,
    registry,
    root,
  };
}
