import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../infra/archive.js";
import {
  type ClawHubSkillDetail,
  type ClawHubSkillSearchResult,
  downloadClawHubSkillArchive,
  fetchClawHubSkillDetail,
  resolveClawHubBaseUrl,
  searchClawHubSkills,
} from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { installPackageDir } from "../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../infra/install-safe-path.js";

const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIR = ".clawdhub";
const SKILL_ORIGIN_RELATIVE_PATH = path.join(DOT_DIR, "origin.json");

export interface ClawHubSkillOrigin {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
}

export interface ClawHubSkillsLockfile {
  version: 1;
  skills: Record<
    string,
    {
      version: string;
      installedAt: number;
    }
  >;
}

export type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      detail: ClawHubSkillDetail;
    }
  | { ok: false; error: string };

export type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
    }
  | { ok: false; error: string };

interface Logger {
  info?: (message: string) => void;
}

const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
// eslint-disable-next-line no-control-regex -- detects any character outside printable ASCII
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;

function normalizeTrackedSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

function validateRequestedSlug(raw: string): string {
  const slug = normalizeTrackedSlug(raw);
  if (NON_ASCII_PATTERN.test(slug) || !VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  lock: ClawHubSkillsLockfile;
}): Promise<string> {
  const trackedSlug = normalizeTrackedSlug(params.requestedSlug);
  const trackedTargetDir = resolveSkillInstallDir(params.workspaceDir, trackedSlug);
  const trackedOrigin = await readClawHubSkillOrigin(trackedTargetDir);
  if (trackedOrigin || params.lock.skills[trackedSlug]) {
    return trackedSlug;
  }
  return validateRequestedSlug(params.requestedSlug);
}

interface ClawHubInstallParams {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
}

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      baseUrl?: string;
      previousVersion: string | null;
    }
  | {
      ok: false;
      slug: string;
      error: string;
    };

function resolveSkillInstallDir(workspaceDir: string, slug: string): string {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const target = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: slug,
    invalidNameMessage: "invalid skill target path",
  });
  if (!target.ok) {
    throw new Error(target.error);
  }
  return target.path;
}

async function ensureSkillRoot(rootDir: string): Promise<void> {
  for (const candidate of ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"]) {
    if (await fileExists(path.join(rootDir, candidate))) {
      return;
    }
  }
  throw new Error("downloaded archive is missing SKILL.md");
}

export async function readClawHubSkillsLockfile(
  workspaceDir: string,
): Promise<ClawHubSkillsLockfile> {
  const candidates = [
    path.join(workspaceDir, DOT_DIR, "lock.json"),
    path.join(workspaceDir, LEGACY_DOT_DIR, "lock.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(
        await fs.readFile(candidate, "utf8"),
      ) as Partial<ClawHubSkillsLockfile>;
      if (raw.version === 1 && raw.skills && typeof raw.skills === "object") {
        return {
          skills: raw.skills,
          version: 1,
        };
      }
    } catch {
      // Ignore
    }
  }
  return { skills: {}, version: 1 };
}

export async function writeClawHubSkillsLockfile(
  workspaceDir: string,
  lockfile: ClawHubSkillsLockfile,
): Promise<void> {
  const targetPath = path.join(workspaceDir, DOT_DIR, "lock.json");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}

export async function readClawHubSkillOrigin(skillDir: string): Promise<ClawHubSkillOrigin | null> {
  const candidates = [
    path.join(skillDir, DOT_DIR, "origin.json"),
    path.join(skillDir, LEGACY_DOT_DIR, "origin.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(candidate, "utf8")) as Partial<ClawHubSkillOrigin>;
      if (
        raw.version === 1 &&
        typeof raw.registry === "string" &&
        typeof raw.slug === "string" &&
        typeof raw.installedVersion === "string" &&
        typeof raw.installedAt === "number"
      ) {
        return raw as ClawHubSkillOrigin;
      }
    } catch {
      // Ignore
    }
  }
  return null;
}

export async function writeClawHubSkillOrigin(
  skillDir: string,
  origin: ClawHubSkillOrigin,
): Promise<void> {
  const targetPath = path.join(skillDir, SKILL_ORIGIN_RELATIVE_PATH);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
}

export async function searchSkillsFromClawHub(params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]> {
  return await searchClawHubSkills({
    baseUrl: params.baseUrl,
    limit: params.limit,
    query: params.query?.trim() || "*",
  });
}

async function resolveInstallVersion(params: {
  slug: string;
  version?: string;
  baseUrl?: string;
}): Promise<{ detail: ClawHubSkillDetail; version: string }> {
  const detail = await fetchClawHubSkillDetail({
    baseUrl: params.baseUrl,
    slug: params.slug,
  });
  if (!detail.skill) {
    throw new Error(`Skill "${params.slug}" not found on ClawHub.`);
  }
  const resolvedVersion = params.version ?? detail.latestVersion?.version;
  if (!resolvedVersion) {
    throw new Error(`Skill "${params.slug}" has no installable version.`);
  }
  return {
    detail,
    version: resolvedVersion,
  };
}

async function installExtractedSkill(params: {
  workspaceDir: string;
  slug: string;
  extractedRoot: string;
  mode: "install" | "update";
  logger?: Logger;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  await ensureSkillRoot(params.extractedRoot);
  const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
  const install = await installPackageDir({
    copyErrorPrefix: "failed to install skill",
    depsLogMessage: "",
    hasDeps: false,
    logger: params.logger,
    mode: params.mode,
    sourceDir: params.extractedRoot,
    targetDir,
    timeoutMs: 120_000,
  });
  if (!install.ok) {
    return install;
  }
  return { ok: true, targetDir };
}

async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const { detail, version } = await resolveInstallVersion({
      baseUrl: params.baseUrl,
      slug: params.slug,
      version: params.version,
    });
    const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
    if (!params.force && (await fileExists(targetDir))) {
      return {
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
        ok: false,
      };
    }

    params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
    const archive = await downloadClawHubSkillArchive({
      baseUrl: params.baseUrl,
      slug: params.slug,
      version,
    });
    try {
      const install = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        onExtracted: async (rootDir) =>
          await installExtractedSkill({
            extractedRoot: rootDir,
            logger: params.logger,
            mode: params.force ? "update" : "install",
            slug: params.slug,
            workspaceDir: params.workspaceDir,
          }),
        rootMarkers: ["SKILL.md"],
        tempDirPrefix: "openclaw-skill-clawhub-",
        timeoutMs: 120_000,
      });
      if (!install.ok) {
        return install;
      }

      const installedAt = Date.now();
      await writeClawHubSkillOrigin(install.targetDir, {
        installedAt,
        installedVersion: version,
        registry: resolveClawHubBaseUrl(params.baseUrl),
        slug: params.slug,
        version: 1,
      });
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      lock.skills[params.slug] = {
        installedAt,
        version,
      };
      await writeClawHubSkillsLockfile(params.workspaceDir, lock);

      return {
        detail,
        ok: true,
        slug: params.slug,
        targetDir: install.targetDir,
        version,
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (error) {
    return {
      error: formatErrorMessage(error),
      ok: false,
    };
  }
}

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: validateRequestedSlug(params.slug),
    });
  } catch (error) {
    return {
      error: formatErrorMessage(error),
      ok: false,
    };
  }
}

async function installTrackedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: normalizeTrackedSlug(params.slug),
    });
  } catch (error) {
    return {
      error: formatErrorMessage(error),
      ok: false,
    };
  }
}

async function resolveTrackedUpdateTarget(params: {
  workspaceDir: string;
  slug: string;
  lock: ClawHubSkillsLockfile;
  baseUrl?: string;
}): Promise<TrackedUpdateTarget> {
  const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
  const origin = (await readClawHubSkillOrigin(targetDir)) ?? null;
  if (!origin && !params.lock.skills[params.slug]) {
    return {
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
      ok: false,
      slug: params.slug,
    };
  }
  return {
    baseUrl: origin?.registry ?? params.baseUrl,
    ok: true,
    previousVersion: origin?.installedVersion ?? params.lock.skills[params.slug]?.version ?? null,
    slug: params.slug,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
}): Promise<InstallClawHubSkillResult> {
  return await installRequestedSkillFromClawHub(params);
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<UpdateClawHubSkillResult[]> {
  const lock = await readClawHubSkillsLockfile(params.workspaceDir);
  const slugs = params.slug
    ? [
        await resolveRequestedUpdateSlug({
          lock,
          requestedSlug: params.slug,
          workspaceDir: params.workspaceDir,
        }),
      ]
    : Object.keys(lock.skills).map((slug) => normalizeTrackedSlug(slug));
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const tracked = await resolveTrackedUpdateTarget({
      baseUrl: params.baseUrl,
      lock,
      slug,
      workspaceDir: params.workspaceDir,
    });
    if (!tracked.ok) {
      results.push({
        error: tracked.error,
        ok: false,
      });
      continue;
    }
    const install = await installTrackedSkillFromClawHub({
      baseUrl: tracked.baseUrl,
      force: true,
      logger: params.logger,
      slug: tracked.slug,
      workspaceDir: params.workspaceDir,
    });
    if (!install.ok) {
      results.push(install);
      continue;
    }
    results.push({
      changed: tracked.previousVersion !== install.version,
      ok: true,
      previousVersion: tracked.previousVersion,
      slug: tracked.slug,
      targetDir: install.targetDir,
      version: install.version,
    });
  }
  return results;
}

export async function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]> {
  const lock = await readClawHubSkillsLockfile(workspaceDir);
  return Object.keys(lock.skills).toSorted();
}

export async function computeSkillFingerprint(skillDir: string): Promise<string> {
  const digest = createHash("sha256");
  const queue = [skillDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relPath = path.relative(skillDir, fullPath).split(path.sep).join("/");
      digest.update(relPath);
      digest.update("\n");
      digest.update(await fs.readFile(fullPath));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}
