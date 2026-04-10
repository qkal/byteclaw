import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("compileMemoryWikiVault", () => {
  let suiteRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-compile-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { force: true, recursive: true });
    }
  });

  function nextCaseRoot() {
    return path.join(suiteRoot, `case-${caseId++}`);
  }

  it("writes root and directory indexes for native markdown", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      rootDir: nextCaseRoot(),
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha\n",
        frontmatter: {
          claims: [
            {
              evidence: [{ sourceId: "source.alpha", lines: "1-3" }],
              id: "claim.alpha.doc",
              status: "supported",
              text: "Alpha is the canonical source page.",
            },
          ],
          id: "source.alpha",
          pageType: "source",
          title: "Alpha",
        },
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.source).toBe(1);
    expect(result.claimCount).toBe(1);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "- Claims: 1",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    const agentDigest = JSON.parse(
      await fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"), "utf8"),
    ) as {
      claimCount: number;
      pages: { path: string; claimCount: number; topClaims: { text: string }[] }[];
    };
    expect(agentDigest.claimCount).toBe(1);
    expect(agentDigest.pages).toContainEqual(
      expect.objectContaining({
        claimCount: 1,
        path: "sources/alpha.md",
        topClaims: [expect.objectContaining({ text: "Alpha is the canonical source page." })],
      }),
    );
    await expect(
      fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl"), "utf8"),
    ).resolves.toContain('"text":"Alpha is the canonical source page."');
  });

  it("renders obsidian-friendly links when configured", async () => {
    const { rootDir, config } = await createVault({
      config: {
        vault: { renderMode: "obsidian" },
      },
      initialize: true,
      rootDir: nextCaseRoot(),
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha\n",
        frontmatter: { id: "source.alpha", pageType: "source", title: "Alpha" },
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[[sources/alpha|Alpha]]",
    );
  });

  it("writes related blocks from source ids and shared sources", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      rootDir: nextCaseRoot(),
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha\n",
        frontmatter: { id: "source.alpha", pageType: "source", title: "Alpha" },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        body: "# Beta\n",
        frontmatter: {
          id: "entity.beta",
          pageType: "entity",
          sourceIds: ["source.alpha"],
          title: "Beta",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        body: "# Gamma\n",
        frontmatter: {
          id: "concept.gamma",
          pageType: "concept",
          sourceIds: ["source.alpha"],
          title: "Gamma",
        },
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "## Related",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Beta](entities/beta.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
  });

  it("writes dashboard report pages when createDashboards is enabled", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      rootDir: nextCaseRoot(),
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha\n",
        frontmatter: {
          claims: [
            {
              confidence: 0.4,
              evidence: [],
              id: "claim.alpha.db",
              status: "supported",
              text: "Alpha uses PostgreSQL for production writes.",
            },
          ],
          confidence: 0.3,
          contradictions: ["Conflicts with source.beta"],
          id: "entity.alpha",
          pageType: "entity",
          questions: ["What changed after launch?"],
          sourceIds: ["source.alpha"],
          title: "Alpha",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "alpha-db.md"),
      renderWikiMarkdown({
        body: "# Alpha DB\n",
        frontmatter: {
          claims: [
            {
              confidence: 0.62,
              evidence: [
                {
                  sourceId: "source.alpha",
                  lines: "9-11",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
              id: "claim.alpha.db",
              status: "contested",
              text: "Alpha uses MySQL for production writes.",
            },
          ],
          id: "concept.alpha.db",
          pageType: "concept",
          sourceIds: ["source.alpha"],
          title: "Alpha DB",
          updatedAt: "2025-10-01T00:00:00.000Z",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha Source\n",
        frontmatter: {
          id: "source.alpha",
          pageType: "source",
          title: "Alpha Source",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.report).toBeGreaterThanOrEqual(5);
    await expect(
      fs.readFile(path.join(rootDir, "reports", "open-questions.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): What changed after launch?");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("Conflicts with source.beta: [Alpha](entities/alpha.md)");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("`claim.alpha.db`");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): confidence 0.30");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("Alpha uses PostgreSQL for production writes.");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "claim-health.md"), "utf8"),
    ).resolves.toContain("Missing Evidence");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "claim-health.md"), "utf8"),
    ).resolves.toContain("Alpha uses PostgreSQL for production writes.");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "stale-pages.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): missing updatedAt");
    const agentDigest = JSON.parse(
      await fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"), "utf8"),
    ) as {
      claimHealth: { missingEvidence: number; freshness: { unknown: number } };
      contradictionClusters: { key: string }[];
    };
    expect(agentDigest.claimHealth.missingEvidence).toBeGreaterThanOrEqual(1);
    expect(agentDigest.claimHealth.freshness.unknown).toBeGreaterThanOrEqual(1);
    expect(agentDigest.contradictionClusters).toContainEqual(
      expect.objectContaining({ key: "claim.alpha.db" }),
    );
  });

  it("skips dashboard report pages when createDashboards is disabled", async () => {
    const { rootDir, config } = await createVault({
      config: {
        render: { createDashboards: false },
      },
      initialize: true,
      rootDir: nextCaseRoot(),
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        body: "# Alpha\n",
        frontmatter: {
          id: "entity.alpha",
          pageType: "entity",
          questions: ["What changed after launch?"],
          sourceIds: ["source.alpha"],
          title: "Alpha",
        },
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.access(path.join(rootDir, "reports", "open-questions.md"))).rejects.toThrow();
  });

  it("ignores generated related links when computing backlinks on repeated compile", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      rootDir: nextCaseRoot(),
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        body: "# Beta\n",
        frontmatter: { id: "entity.beta", pageType: "entity", title: "Beta" },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        body: "# Gamma\n\nSee [Beta](entities/beta.md).\n",
        frontmatter: { id: "concept.gamma", pageType: "concept", title: "Gamma" },
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);
    const second = await compileMemoryWikiVault(config);

    expect(second.updatedFiles).toEqual([]);
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(
      fs.readFile(path.join(rootDir, "concepts", "gamma.md"), "utf8"),
    ).resolves.not.toContain("### Referenced By");
  });
});
