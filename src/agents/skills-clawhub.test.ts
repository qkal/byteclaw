import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchClawHubSkillDetailMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const listClawHubSkillsMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const searchClawHubSkillsMock = vi.fn();
const archiveCleanupMock = vi.fn();
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const fileExistsMock = vi.fn();

vi.mock("../infra/clawhub.js", () => ({
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  listClawHubSkills: listClawHubSkillsMock,
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
  searchClawHubSkills: searchClawHubSkillsMock,
}));

vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: withExtractedArchiveRootMock,
}));

vi.mock("../infra/install-package-dir.js", () => ({
  installPackageDir: installPackageDirMock,
}));

vi.mock("../infra/archive.js", () => ({
  fileExists: fileExistsMock,
}));

const { installSkillFromClawHub, searchSkillsFromClawHub, updateSkillsFromClawHub } =
  await import("./skills-clawhub.js");

describe("skills-clawhub", () => {
  beforeEach(() => {
    fetchClawHubSkillDetailMock.mockReset();
    downloadClawHubSkillArchiveMock.mockReset();
    listClawHubSkillsMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset();
    searchClawHubSkillsMock.mockReset();
    archiveCleanupMock.mockReset();
    withExtractedArchiveRootMock.mockReset();
    installPackageDirMock.mockReset();
    fileExistsMock.mockReset();

    resolveClawHubBaseUrlMock.mockReturnValue("https://clawhub.ai");
    fileExistsMock.mockImplementation(async (input: string) => input.endsWith("SKILL.md"));
    fetchClawHubSkillDetailMock.mockResolvedValue({
      latestVersion: {
        createdAt: 3,
        version: "1.0.0",
      },
      skill: {
        createdAt: 1,
        displayName: "AgentReceipt",
        slug: "agentreceipt",
        updatedAt: 2,
      },
    });
    downloadClawHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      cleanup: archiveCleanupMock,
      integrity: "sha256-test",
    });
    archiveCleanupMock.mockResolvedValue(undefined);
    searchClawHubSkillsMock.mockResolvedValue([]);
    withExtractedArchiveRootMock.mockImplementation(async (params) => {
      expect(params.rootMarkers).toEqual(["SKILL.md"]);
      return await params.onExtracted("/tmp/extracted-skill");
    });
    installPackageDirMock.mockResolvedValue({
      ok: true,
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
  });

  it("installs ClawHub skills from flat-root archives", async () => {
    const result = await installSkillFromClawHub({
      slug: "agentreceipt",
      workspaceDir: "/tmp/workspace",
    });

    expect(downloadClawHubSkillArchiveMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      slug: "agentreceipt",
      version: "1.0.0",
    });
    expect(installPackageDirMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir: "/tmp/extracted-skill",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      slug: "agentreceipt",
      targetDir: "/tmp/workspace/skills/agentreceipt",
      version: "1.0.0",
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  describe("legacy tracked slugs remain updatable", () => {
    async function createLegacyTrackedSkillFixture(slug: string) {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-"));
      const skillDir = path.join(workspaceDir, "skills", slug);
      await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
      await fs.writeFile(
        path.join(skillDir, ".clawhub", "origin.json"),
        `${JSON.stringify(
          {
            installedAt: 123,
            installedVersion: "0.9.0",
            registry: "https://legacy.clawhub.ai",
            slug,
            version: 1,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, ".clawhub", "lock.json"),
        `${JSON.stringify(
          {
            skills: {
              [slug]: {
                installedAt: 123,
                version: "0.9.0",
              },
            },
            version: 1,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { skillDir, workspaceDir };
    }

    it("updates all tracked legacy Unicode slugs in place", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createLegacyTrackedSkillFixture(slug);
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
        });

        expect(fetchClawHubSkillDetailMock).toHaveBeenCalledWith({
          baseUrl: "https://legacy.clawhub.ai",
          slug,
        });
        expect(downloadClawHubSkillArchiveMock).toHaveBeenCalledWith({
          baseUrl: "https://legacy.clawhub.ai",
          slug,
          version: "1.0.0",
        });
        expect(results).toMatchObject([
          {
            ok: true,
            previousVersion: "0.9.0",
            slug,
            targetDir: path.join(workspaceDir, "skills", slug),
            version: "1.0.0",
          },
        ]);
      } finally {
        await fs.rm(workspaceDir, { force: true, recursive: true });
      }
    });

    it("updates a legacy Unicode slug when requested explicitly", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createLegacyTrackedSkillFixture(slug);
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          slug,
          workspaceDir,
        });

        expect(results).toMatchObject([
          {
            ok: true,
            previousVersion: "0.9.0",
            slug,
            targetDir: path.join(workspaceDir, "skills", slug),
            version: "1.0.0",
          },
        ]);
      } finally {
        await fs.rm(workspaceDir, { force: true, recursive: true });
      }
    });

    it("still rejects an untracked Unicode slug passed to update", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-"));

      try {
        await expect(
          updateSkillsFromClawHub({
            slug: "re\u0430ct",
            workspaceDir,
          }),
        ).rejects.toThrow("Invalid skill slug");
      } finally {
        await fs.rm(workspaceDir, { force: true, recursive: true });
      }
    });
  });

  describe("normalizeSlug rejects non-ASCII homograph slugs", () => {
    it("rejects Cyrillic homograph 'а' (U+0430) in slug", async () => {
      const result = await installSkillFromClawHub({
        slug: "re\u0430ct",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("rejects Cyrillic homograph 'е' (U+0435) in slug", async () => {
      const result = await installSkillFromClawHub({
        slug: "r\u0435act",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("rejects Cyrillic homograph 'о' (U+043E) in slug", async () => {
      const result = await installSkillFromClawHub({
        slug: "t\u043Edo",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("rejects slug with mixed Unicode and ASCII", async () => {
      const result = await installSkillFromClawHub({
        slug: "cаlеndаr",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("rejects slug with non-Latin scripts", async () => {
      const result = await installSkillFromClawHub({
        slug: "技能",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("rejects Unicode that case-folds to ASCII (Kelvin sign U+212A)", async () => {
      // "\u212A" (Kelvin sign) lowercases to "k" — must be caught before lowercasing
      const result = await installSkillFromClawHub({
        slug: "\u212Aalendar",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("rejects slug starting with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        slug: "-calendar",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("rejects slug ending with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        slug: "calendar-",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid skill slug"),
        ok: false,
      });
    });

    it("accepts uppercase ASCII slugs (preserves original casing behavior)", async () => {
      const result = await installSkillFromClawHub({
        slug: "React",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({ ok: true });
    });

    it("accepts valid lowercase ASCII slugs", async () => {
      const result = await installSkillFromClawHub({
        slug: "calendar-2",
        workspaceDir: "/tmp/workspace",
      });
      expect(result).toMatchObject({ ok: true });
    });
  });

  it("uses search for browse-all skill discovery", async () => {
    searchClawHubSkillsMock.mockResolvedValueOnce([
      {
        displayName: "Calendar",
        score: 1,
        slug: "calendar",
        summary: "Calendar skill",
        updatedAt: 123,
        version: "1.2.3",
      },
    ]);

    await expect(searchSkillsFromClawHub({ limit: 20 })).resolves.toEqual([
      {
        displayName: "Calendar",
        score: 1,
        slug: "calendar",
        summary: "Calendar skill",
        updatedAt: 123,
        version: "1.2.3",
      },
    ]);
    expect(searchClawHubSkillsMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      limit: 20,
      query: "*",
    });
    expect(listClawHubSkillsMock).not.toHaveBeenCalled();
  });
});
