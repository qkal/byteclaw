import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveArchiveKind } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isPathInside } from "../infra/path-guards.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { type InstallPluginResult, installPluginFromPath } from "./install.js";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_MARKETPLACE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MARKETPLACE_MANIFEST_CANDIDATES = [
  path.join(".claude-plugin", "marketplace.json"),
  "marketplace.json",
] as const;
const CLAUDE_KNOWN_MARKETPLACES_PATH = path.join(
  "~",
  ".claude",
  "plugins",
  "known_marketplaces.json",
);

interface MarketplaceLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

type MarketplaceEntrySource =
  | { kind: "path"; path: string }
  | { kind: "github"; repo: string; path?: string; ref?: string }
  | { kind: "git"; url: string; path?: string; ref?: string }
  | { kind: "git-subdir"; url: string; path: string; ref?: string }
  | { kind: "url"; url: string };

export interface MarketplacePluginEntry {
  name: string;
  version?: string;
  description?: string;
  source: MarketplaceEntrySource;
}

export interface MarketplaceManifest {
  name?: string;
  version?: string;
  plugins: MarketplacePluginEntry[];
}

interface LoadedMarketplace {
  manifest: MarketplaceManifest;
  rootDir: string;
  sourceLabel: string;
  origin: MarketplaceManifestOrigin;
  cleanup?: () => Promise<void>;
}

type MarketplaceManifestOrigin = "local" | "remote";

interface ResolvedLocalMarketplaceSource {
  manifestPath: string;
  rootDir: string;
}

interface KnownMarketplaceRecord {
  installLocation?: string;
  source?: unknown;
}

export type MarketplacePluginListResult =
  | {
      ok: true;
      manifest: MarketplaceManifest;
      sourceLabel: string;
    }
  | {
      ok: false;
      error: string;
    };

export type MarketplaceInstallResult =
  | ({
      ok: true;
      marketplaceName?: string;
      marketplaceVersion?: string;
      marketplacePlugin: string;
      marketplaceSource: string;
      marketplaceEntryVersion?: string;
    } & Extract<InstallPluginResult, { ok: true }>)
  | Extract<InstallPluginResult, { ok: false }>;

export type MarketplaceShortcutResolution =
  | {
      ok: true;
      plugin: string;
      marketplaceName: string;
      marketplaceSource: string;
    }
  | {
      ok: false;
      error: string;
    }
  | null;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isGitUrl(value: string): boolean {
  return (
    /^git@/i.test(value) || /^ssh:\/\//i.test(value) || /^https?:\/\/.+\.git(?:#.*)?$/i.test(value)
  );
}

function looksLikeGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/.test(value.trim());
}

function splitRef(value: string): { base: string; ref?: string } {
  const trimmed = value.trim();
  const hashIndex = trimmed.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex >= trimmed.length - 1) {
    return { base: trimmed };
  }
  return {
    base: trimmed.slice(0, hashIndex),
    ref: normalizeOptionalString(trimmed.slice(hashIndex + 1)),
  };
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEntrySource(
  raw: unknown,
): { ok: true; source: MarketplaceEntrySource } | { ok: false; error: string } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { error: "empty plugin source", ok: false };
    }
    if (isHttpUrl(trimmed)) {
      return { ok: true, source: { kind: "url", url: trimmed } };
    }
    return { ok: true, source: { kind: "path", path: trimmed } };
  }

  if (!raw || typeof raw !== "object") {
    return { error: "plugin source must be a string or object", ok: false };
  }

  const rec = raw as Record<string, unknown>;
  const kind = toOptionalString(rec.type) ?? toOptionalString(rec.source);
  if (!kind) {
    return { error: 'plugin source object missing "type" or "source"', ok: false };
  }

  if (kind === "path") {
    const sourcePath = toOptionalString(rec.path);
    if (!sourcePath) {
      return { error: 'path source missing "path"', ok: false };
    }
    return { ok: true, source: { kind: "path", path: sourcePath } };
  }

  if (kind === "github") {
    const repo = toOptionalString(rec.repo) ?? toOptionalString(rec.url);
    if (!repo) {
      return { error: 'github source missing "repo"', ok: false };
    }
    return {
      ok: true,
      source: {
        kind: "github",
        path: toOptionalString(rec.path),
        ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag),
        repo,
      },
    };
  }

  if (kind === "git") {
    const url = toOptionalString(rec.url) ?? toOptionalString(rec.repo);
    if (!url) {
      return { error: 'git source missing "url"', ok: false };
    }
    return {
      ok: true,
      source: {
        kind: "git",
        path: toOptionalString(rec.path),
        ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag),
        url,
      },
    };
  }

  if (kind === "git-subdir") {
    const url = toOptionalString(rec.url) ?? toOptionalString(rec.repo);
    const sourcePath = toOptionalString(rec.path) ?? toOptionalString(rec.subdir);
    if (!url) {
      return { error: 'git-subdir source missing "url"', ok: false };
    }
    if (!sourcePath) {
      return { error: 'git-subdir source missing "path"', ok: false };
    }
    return {
      ok: true,
      source: {
        kind: "git-subdir",
        path: sourcePath,
        ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag),
        url,
      },
    };
  }

  if (kind === "url") {
    const url = toOptionalString(rec.url);
    if (!url) {
      return { error: 'url source missing "url"', ok: false };
    }
    return { ok: true, source: { kind: "url", url } };
  }

  return { error: `unsupported plugin source kind: ${kind}`, ok: false };
}

function marketplaceEntrySourceToInput(source: MarketplaceEntrySource): string {
  switch (source.kind) {
    case "path": {
      return source.path;
    }
    case "github": {
      return `${source.repo}${source.ref ? `#${source.ref}` : ""}`;
    }
    case "git": {
      return `${source.url}${source.ref ? `#${source.ref}` : ""}`;
    }
    case "git-subdir": {
      return `${source.url}${source.ref ? `#${source.ref}` : ""}`;
    }
    case "url": {
      return source.url;
    }
  }
}

function parseMarketplaceManifest(
  raw: string,
  sourceLabel: string,
): { ok: true; manifest: MarketplaceManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `invalid marketplace JSON at ${sourceLabel}: ${String(error)}`, ok: false };
  }

  if (!parsed || typeof parsed !== "object") {
    return { error: `invalid marketplace JSON at ${sourceLabel}: expected object`, ok: false };
  }

  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.plugins)) {
    return { error: `invalid marketplace JSON at ${sourceLabel}: missing plugins[]`, ok: false };
  }

  const plugins: MarketplacePluginEntry[] = [];
  for (const entry of rec.plugins) {
    if (!entry || typeof entry !== "object") {
      return { error: `invalid marketplace entry in ${sourceLabel}: expected object`, ok: false };
    }
    const plugin = entry as Record<string, unknown>;
    const name = toOptionalString(plugin.name);
    if (!name) {
      return { error: `invalid marketplace entry in ${sourceLabel}: missing name`, ok: false };
    }
    const normalizedSource = normalizeEntrySource(plugin.source);
    if (!normalizedSource.ok) {
      return {
        error: `invalid marketplace entry "${name}" in ${sourceLabel}: ${normalizedSource.error}`,
        ok: false,
      };
    }
    plugins.push({
      description: toOptionalString(plugin.description),
      name,
      source: normalizedSource.source,
      version: toOptionalString(plugin.version),
    });
  }

  return {
    manifest: {
      name: toOptionalString(rec.name),
      plugins,
      version: toOptionalString(rec.version),
    },
    ok: true,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readClaudeKnownMarketplaces(): Promise<Record<string, KnownMarketplaceRecord>> {
  const knownPath = resolveOsHomeRelativePath(CLAUDE_KNOWN_MARKETPLACES_PATH);
  if (!(await pathExists(knownPath))) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(knownPath, "utf8"));
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const entries = parsed as Record<string, unknown>;
  const result: Record<string, KnownMarketplaceRecord> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as Record<string, unknown>;
    result[name] = {
      installLocation: toOptionalString(record.installLocation),
      source: record.source,
    };
  }
  return result;
}

function deriveMarketplaceRootFromManifestPath(manifestPath: string): string {
  const manifestDir = path.dirname(manifestPath);
  return path.basename(manifestDir) === ".claude-plugin" ? path.dirname(manifestDir) : manifestDir;
}

async function resolveLocalMarketplaceSource(
  input: string,
): Promise<
  { ok: true; rootDir: string; manifestPath: string } | { ok: false; error: string } | null
> {
  const resolved = resolveUserPath(input);
  if (!(await pathExists(resolved))) {
    return null;
  }

  const stat = await fs.stat(resolved);
  if (stat.isFile()) {
    const rootDir = deriveMarketplaceRootFromManifestPath(resolved);
    return {
      manifestPath: resolved,
      ok: true,
      rootDir,
    };
  }

  if (!stat.isDirectory()) {
    return { error: `unsupported marketplace source: ${resolved}`, ok: false };
  }

  const rootDir = path.basename(resolved) === ".claude-plugin" ? path.dirname(resolved) : resolved;
  for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(rootDir, candidate);
    if (await pathExists(manifestPath)) {
      return { manifestPath, ok: true, rootDir };
    }
  }

  return { error: `marketplace manifest not found under ${resolved}`, ok: false };
}

function normalizeGitCloneSource(
  source: string,
): { url: string; ref?: string; label: string } | null {
  const split = splitRef(source);
  if (looksLikeGitHubRepoShorthand(split.base)) {
    return {
      label: split.base,
      ref: split.ref,
      url: `https://github.com/${split.base}.git`,
    };
  }

  if (isGitUrl(source)) {
    return {
      label: split.base,
      ref: split.ref,
      url: split.base,
    };
  }

  if (isHttpUrl(source)) {
    try {
      const url = new URL(split.base);
      if (url.hostname !== "github.com") {
        return null;
      }
      const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      if (parts.length < 2) {
        return null;
      }
      const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/i, "")}`;
      return {
        label: repo,
        ref: split.ref,
        url: `https://github.com/${repo}.git`,
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function cloneMarketplaceRepo(params: {
  source: string;
  timeoutMs?: number;
  logger?: MarketplaceLogger;
}): Promise<
  | { ok: true; rootDir: string; cleanup: () => Promise<void>; label: string }
  | { ok: false; error: string }
> {
  const normalized = normalizeGitCloneSource(params.source);
  if (!normalized) {
    return { error: `unsupported marketplace source: ${params.source}`, ok: false };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-"));
  const repoDir = path.join(tmpDir, "repo");
  const argv = ["git", "clone", "--depth", "1"];
  if (normalized.ref) {
    argv.push("--branch", normalized.ref);
  }
  argv.push(normalized.url, repoDir);
  params.logger?.info?.(`Cloning marketplace source ${normalized.label}...`);
  const res = await runCommandWithTimeout(argv, {
    timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    await fs.rm(tmpDir, { force: true, recursive: true }).catch(() => undefined);
    const detail = res.stderr.trim() || res.stdout.trim() || "git clone failed";
    return {
      error: `failed to clone marketplace source ${normalized.label}: ${detail}`,
      ok: false,
    };
  }

  return {
    cleanup: async () => {
      await fs.rm(tmpDir, { force: true, recursive: true }).catch(() => undefined);
    },
    label: normalized.label,
    ok: true,
    rootDir: repoDir,
  };
}

async function loadMarketplace(params: {
  source: string;
  logger?: MarketplaceLogger;
  timeoutMs?: number;
}): Promise<{ ok: true; marketplace: LoadedMarketplace } | { ok: false; error: string }> {
  const loadMarketplaceFromManifestFile = async (params: {
    manifestPath: string;
    sourceLabel: string;
    rootDir: string;
    origin: MarketplaceManifestOrigin;
    cleanup?: () => Promise<void>;
  }): Promise<{ ok: true; marketplace: LoadedMarketplace } | { ok: false; error: string }> => {
    const raw = await fs.readFile(params.manifestPath, "utf8");
    const parsed = parseMarketplaceManifest(raw, params.manifestPath);
    if (!parsed.ok) {
      await params.cleanup?.();
      return parsed;
    }
    const validated = await validateMarketplaceManifest({
      manifest: parsed.manifest,
      origin: params.origin,
      rootDir: params.rootDir,
      sourceLabel: params.sourceLabel,
    });
    if (!validated.ok) {
      await params.cleanup?.();
      return validated;
    }
    return {
      marketplace: {
        cleanup: params.cleanup,
        manifest: validated.manifest,
        origin: params.origin,
        rootDir: params.rootDir,
        sourceLabel: params.sourceLabel,
      },
      ok: true,
    };
  };

  const loadResolvedLocalMarketplace = async (
    local: ResolvedLocalMarketplaceSource,
    sourceLabel: string,
  ): Promise<{ ok: true; marketplace: LoadedMarketplace } | { ok: false; error: string }> =>
    loadMarketplaceFromManifestFile({
      manifestPath: local.manifestPath,
      origin: "local",
      rootDir: local.rootDir,
      sourceLabel,
    });

  const resolveClonedMarketplaceManifestPath = async (
    rootDir: string,
  ): Promise<string | undefined> => {
    for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
      const next = path.join(rootDir, candidate);
      if (await pathExists(next)) {
        return next;
      }
    }
    return undefined;
  };

  const knownMarketplaces = await readClaudeKnownMarketplaces();
  const known = knownMarketplaces[params.source];
  if (known) {
    if (known.installLocation) {
      const local = await resolveLocalMarketplaceSource(known.installLocation);
      if (local?.ok) {
        return await loadResolvedLocalMarketplace(local, params.source);
      }
    }

    const normalizedSource = normalizeEntrySource(known.source);
    if (normalizedSource.ok) {
      return await loadMarketplace({
        logger: params.logger,
        source: marketplaceEntrySourceToInput(normalizedSource.source),
        timeoutMs: params.timeoutMs,
      });
    }
  }

  const local = await resolveLocalMarketplaceSource(params.source);
  if (local?.ok === false) {
    return local;
  }

  if (local?.ok) {
    return await loadResolvedLocalMarketplace(local, local.manifestPath);
  }

  const cloned = await cloneMarketplaceRepo({
    logger: params.logger,
    source: params.source,
    timeoutMs: params.timeoutMs,
  });
  if (!cloned.ok) {
    return cloned;
  }

  const manifestPath = await resolveClonedMarketplaceManifestPath(cloned.rootDir);
  if (!manifestPath) {
    await cloned.cleanup();
    return { error: `marketplace manifest not found in ${cloned.label}`, ok: false };
  }

  return await loadMarketplaceFromManifestFile({
    cleanup: cloned.cleanup,
    manifestPath,
    origin: "remote",
    rootDir: cloned.rootDir,
    sourceLabel: cloned.label,
  });
}

function resolveSafeMarketplaceDownloadFileName(url: string, fallback: string): string {
  const { pathname } = new URL(url);
  const fileName = path.basename(pathname).trim() || fallback;
  if (
    fileName === "." ||
    fileName === ".." ||
    /^[a-zA-Z]:/.test(fileName) ||
    path.isAbsolute(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error("invalid download filename");
  }
  return fileName;
}

function resolveMarketplaceDownloadTimeoutMs(timeoutMs?: number): number {
  const resolvedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS;
  return Math.max(1000, Math.floor(resolvedTimeoutMs));
}

function formatMarketplaceDownloadError(url: string, detail: string): string {
  return (
    `failed to download ${sanitizeForLog(redactSensitiveUrlLikeString(url))}: ` +
    sanitizeForLog(detail)
  );
}

function hasStreamingResponseBody(
  response: Response,
): response is Response & { body: ReadableStream<Uint8Array> } {
  return Boolean(
    response.body && typeof (response.body as { getReader?: unknown }).getReader === "function",
  );
}

async function readMarketplaceChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  return await new Promise((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    timeoutId = setTimeout(() => {
      timedOut = true;
      clear();
      void reader.cancel().catch(() => undefined);
      reject(new Error(`download timed out after ${chunkTimeoutMs}ms`));
    }, chunkTimeoutMs);

    void reader.read().then(
      (result) => {
        clear();
        if (!timedOut) {
          resolve(result);
        }
      },
      (error) => {
        clear();
        if (!timedOut) {
          reject(error);
        }
      },
    );
  });
}

async function writeMarketplaceChunk(
  fileHandle: Awaited<ReturnType<typeof fs.open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await fileHandle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) {
      throw new Error("failed to write download chunk");
    }
    offset += bytesWritten;
  }
}

async function streamMarketplaceResponseToFile(params: {
  response: Response & { body: ReadableStream<Uint8Array> };
  targetPath: string;
  maxBytes: number;
  chunkTimeoutMs: number;
}): Promise<void> {
  const reader = params.response.body.getReader();
  const fileHandle = await fs.open(params.targetPath, "wx");
  let total = 0;

  try {
    while (true) {
      const { done, value } = await readMarketplaceChunkWithTimeout(reader, params.chunkTimeoutMs);
      if (done) {
        return;
      }
      if (!value?.length) {
        continue;
      }

      const nextTotal = total + value.length;
      if (nextTotal > params.maxBytes) {
        throw new Error(`download too large: ${nextTotal} bytes (limit: ${params.maxBytes} bytes)`);
      }

      await writeMarketplaceChunk(fileHandle, value);
      total = nextTotal;
    }
  } finally {
    await fileHandle.close().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function downloadUrlToTempFile(
  url: string,
  timeoutMs?: number,
): Promise<
  | {
      ok: true;
      path: string;
      cleanup: () => Promise<void>;
    }
  | {
      ok: false;
      error: string;
    }
> {
  let sourceFileName = "plugin.tgz";
  let tmpDir: string | undefined;
  try {
    sourceFileName = resolveSafeMarketplaceDownloadFileName(url, sourceFileName);
    const downloadTimeoutMs = resolveMarketplaceDownloadTimeoutMs(timeoutMs);
    const { response, finalUrl, release } = await fetchWithSsrFGuard({
      auditContext: "marketplace-plugin-download",
      timeoutMs: downloadTimeoutMs,
      url,
    });
    try {
      if (!response.ok) {
        return {
          error: formatMarketplaceDownloadError(url, `HTTP ${response.status}`),
          ok: false,
        };
      }
      if (!response.body) {
        return {
          error: formatMarketplaceDownloadError(url, "empty response body"),
          ok: false,
        };
      }
      // Fail closed unless we can stream and enforce the archive size bound incrementally.
      if (!hasStreamingResponseBody(response)) {
        return {
          error: formatMarketplaceDownloadError(url, "streaming response body unavailable"),
          ok: false,
        };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const size = Number(contentLength);
        if (Number.isFinite(size) && size > MAX_MARKETPLACE_ARCHIVE_BYTES) {
          throw new Error(
            `download too large: ${size} bytes (limit: ${MAX_MARKETPLACE_ARCHIVE_BYTES} bytes)`,
          );
        }
      }

      const finalFileName = resolveSafeMarketplaceDownloadFileName(finalUrl, sourceFileName);
      const fileName = resolveArchiveKind(finalFileName) ? finalFileName : sourceFileName;
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-download-"));
      const createdTmpDir = tmpDir;
      const targetPath = path.resolve(createdTmpDir, fileName);
      const relativeTargetPath = path.relative(createdTmpDir, targetPath);
      if (relativeTargetPath === ".." || relativeTargetPath.startsWith(`..${path.sep}`)) {
        throw new Error("invalid download filename");
      }
      await streamMarketplaceResponseToFile({
        chunkTimeoutMs: downloadTimeoutMs,
        maxBytes: MAX_MARKETPLACE_ARCHIVE_BYTES,
        response,
        targetPath,
      });
      return {
        cleanup: async () => {
          await fs.rm(createdTmpDir, { force: true, recursive: true }).catch(() => undefined);
        },
        ok: true,
        path: targetPath,
      };
    } finally {
      await release().catch(() => undefined);
    }
  } catch (error) {
    if (tmpDir) {
      await fs.rm(tmpDir, { force: true, recursive: true }).catch(() => undefined);
    }
    return {
      error: formatMarketplaceDownloadError(url, formatErrorMessage(error)),
      ok: false,
    };
  }
}

async function ensureInsideMarketplaceRoot(
  rootDir: string,
  candidate: string,
  options?: { canonicalRootDir?: string },
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const resolved = path.resolve(rootDir, candidate);
  const resolvedExists = await pathExists(resolved);
  const relative = path.relative(rootDir, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return {
      error: `plugin source escapes marketplace root: ${candidate}`,
      ok: false,
    };
  }

  if (options?.canonicalRootDir) {
    try {
      const rootLstat = await fs.lstat(options.canonicalRootDir);
      if (!rootLstat.isDirectory()) {
        throw new Error("invalid marketplace root");
      }

      const rootRealPath = await fs.realpath(options.canonicalRootDir);
      let existingPath = resolved;
      // `pathExists` uses `fs.access`, so dangling symlinks are treated as missing and we walk up
      // To the nearest existing ancestor. Live symlinks stop here and are canonicalized below.
      while (!(await pathExists(existingPath))) {
        const parentPath = path.dirname(existingPath);
        if (parentPath === existingPath) {
          throw new Error("unreachable marketplace path");
        }
        existingPath = parentPath;
      }

      const existingRealPath = await fs.realpath(existingPath);
      if (!isPathInside(rootRealPath, existingRealPath)) {
        throw new Error("marketplace path escapes canonical root");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "invalid marketplace root" ||
          error.message === "unreachable marketplace path" ||
          error.message === "marketplace path escapes canonical root")
      ) {
        return {
          error: `plugin source escapes marketplace root: ${candidate}`,
          ok: false,
        };
      }
      throw error;
    }
  }

  if (!resolvedExists) {
    return {
      error: `plugin source not found in marketplace root: ${candidate}`,
      ok: false,
    };
  }

  return { ok: true, path: resolved };
}

async function validateMarketplaceManifest(params: {
  manifest: MarketplaceManifest;
  sourceLabel: string;
  rootDir: string;
  origin: MarketplaceManifestOrigin;
}): Promise<{ ok: true; manifest: MarketplaceManifest } | { ok: false; error: string }> {
  if (params.origin === "local") {
    return { manifest: params.manifest, ok: true };
  }

  const canonicalRootDir = await fs.realpath(params.rootDir);
  for (const plugin of params.manifest.plugins) {
    const { source } = plugin;
    if (source.kind === "path") {
      if (isHttpUrl(source.path)) {
        return {
          error:
            `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ` +
            "remote marketplaces may not use HTTP(S) plugin paths",
          ok: false,
        };
      }
      if (path.isAbsolute(source.path)) {
        return {
          error:
            `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ` +
            "remote marketplaces may only use relative plugin paths",
          ok: false,
        };
      }
      const resolved = await ensureInsideMarketplaceRoot(params.rootDir, source.path, {
        canonicalRootDir,
      });
      if (!resolved.ok) {
        return {
          error: `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ${resolved.error}`,
          ok: false,
        };
      }
      continue;
    }

    return {
      error:
        `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ` +
        `remote marketplaces may not use ${source.kind} plugin sources`,
      ok: false,
    };
  }

  return { manifest: params.manifest, ok: true };
}

async function resolveMarketplaceEntryInstallPath(params: {
  source: MarketplaceEntrySource;
  marketplaceRootDir: string;
  marketplaceOrigin: MarketplaceManifestOrigin;
  logger?: MarketplaceLogger;
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      path: string;
      cleanup?: () => Promise<void>;
    }
  | {
      ok: false;
      error: string;
    }
> {
  if (params.source.kind === "path") {
    if (isHttpUrl(params.source.path)) {
      if (resolveArchiveKind(params.source.path)) {
        return await downloadUrlToTempFile(params.source.path, params.timeoutMs);
      }
      return {
        error: `unsupported remote plugin path source: ${params.source.path}`,
        ok: false,
      };
    }
    const canonicalRootDir =
      params.marketplaceOrigin === "remote"
        ? await fs.realpath(params.marketplaceRootDir)
        : undefined;
    const resolved = path.isAbsolute(params.source.path)
      ? { ok: true as const, path: params.source.path }
      : await ensureInsideMarketplaceRoot(params.marketplaceRootDir, params.source.path, {
          canonicalRootDir,
        });
    if (!resolved.ok) {
      return resolved;
    }
    return { ok: true, path: resolved.path };
  }

  if (
    params.source.kind === "github" ||
    params.source.kind === "git" ||
    params.source.kind === "git-subdir"
  ) {
    const sourceSpec =
      params.source.kind === "github"
        ? `${params.source.repo}${params.source.ref ? `#${params.source.ref}` : ""}`
        : `${params.source.url}${params.source.ref ? `#${params.source.ref}` : ""}`;
    const cloned = await cloneMarketplaceRepo({
      logger: params.logger,
      source: sourceSpec,
      timeoutMs: params.timeoutMs,
    });
    if (!cloned.ok) {
      return cloned;
    }
    const subPath =
      params.source.kind === "github" || params.source.kind === "git"
        ? normalizeOptionalString(params.source.path) || "."
        : params.source.path.trim();
    const canonicalRootDir = await fs.realpath(cloned.rootDir);
    const target = await ensureInsideMarketplaceRoot(cloned.rootDir, subPath, {
      canonicalRootDir,
    });
    if (!target.ok) {
      await cloned.cleanup();
      return target;
    }
    return {
      cleanup: cloned.cleanup,
      ok: true,
      path: target.path,
    };
  }

  if (resolveArchiveKind(params.source.url)) {
    return await downloadUrlToTempFile(params.source.url, params.timeoutMs);
  }

  if (!normalizeGitCloneSource(params.source.url)) {
    return {
      error: `unsupported URL plugin source: ${params.source.url}`,
      ok: false,
    };
  }

  const cloned = await cloneMarketplaceRepo({
    logger: params.logger,
    source: params.source.url,
    timeoutMs: params.timeoutMs,
  });
  if (!cloned.ok) {
    return cloned;
  }
  return {
    cleanup: cloned.cleanup,
    ok: true,
    path: cloned.rootDir,
  };
}

export async function listMarketplacePlugins(params: {
  marketplace: string;
  logger?: MarketplaceLogger;
  timeoutMs?: number;
}): Promise<MarketplacePluginListResult> {
  const loaded = await loadMarketplace({
    logger: params.logger,
    source: params.marketplace,
    timeoutMs: params.timeoutMs,
  });
  if (!loaded.ok) {
    return loaded;
  }
  try {
    return {
      manifest: loaded.marketplace.manifest,
      ok: true,
      sourceLabel: loaded.marketplace.sourceLabel,
    };
  } finally {
    await loaded.marketplace.cleanup?.();
  }
}

export async function resolveMarketplaceInstallShortcut(
  raw: string,
): Promise<MarketplaceShortcutResolution> {
  const trimmed = raw.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex >= trimmed.length - 1) {
    return null;
  }

  const plugin = trimmed.slice(0, atIndex).trim();
  const marketplaceName = trimmed.slice(atIndex + 1).trim();
  if (!plugin || !marketplaceName || plugin.includes("/")) {
    return null;
  }

  const knownMarketplaces = await readClaudeKnownMarketplaces();
  const known = knownMarketplaces[marketplaceName];
  if (!known) {
    return null;
  }

  if (known.installLocation) {
    return {
      marketplaceName,
      marketplaceSource: marketplaceName,
      ok: true,
      plugin,
    };
  }

  const normalizedSource = normalizeEntrySource(known.source);
  if (!normalizedSource.ok) {
    return {
      error: `known Claude marketplace "${marketplaceName}" has an invalid source: ${normalizedSource.error}`,
      ok: false,
    };
  }

  return {
    marketplaceName,
    marketplaceSource: marketplaceName,
    ok: true,
    plugin,
  };
}

export async function installPluginFromMarketplace(
  params: InstallSafetyOverrides & {
    marketplace: string;
    plugin: string;
    logger?: MarketplaceLogger;
    timeoutMs?: number;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
  },
): Promise<MarketplaceInstallResult> {
  const loaded = await loadMarketplace({
    logger: params.logger,
    source: params.marketplace,
    timeoutMs: params.timeoutMs,
  });
  if (!loaded.ok) {
    return loaded;
  }

  let installCleanup: (() => Promise<void>) | undefined;
  try {
    const entry = loaded.marketplace.manifest.plugins.find(
      (plugin) => plugin.name === params.plugin,
    );
    if (!entry) {
      const known = loaded.marketplace.manifest.plugins.map((plugin) => plugin.name).toSorted();
      return {
        error:
          `plugin "${params.plugin}" not found in marketplace ${loaded.marketplace.sourceLabel}` +
          (known.length > 0 ? ` (available: ${known.join(", ")})` : ""),
        ok: false,
      };
    }

    const resolved = await resolveMarketplaceEntryInstallPath({
      logger: params.logger,
      marketplaceOrigin: loaded.marketplace.origin,
      marketplaceRootDir: loaded.marketplace.rootDir,
      source: entry.source,
      timeoutMs: params.timeoutMs,
    });
    if (!resolved.ok) {
      return resolved;
    }
    installCleanup = resolved.cleanup;

    const result = await installPluginFromPath({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
      logger: params.logger,
      mode: params.mode,
      path: resolved.path,
    });
    if (!result.ok) {
      return result;
    }
    return {
      ...result,
      marketplaceEntryVersion: entry.version,
      marketplaceName: loaded.marketplace.manifest.name,
      marketplacePlugin: entry.name,
      marketplaceSource: params.marketplace,
      marketplaceVersion: loaded.marketplace.manifest.version,
    };
  } finally {
    await installCleanup?.();
    await loaded.marketplace.cleanup?.();
  }
}
