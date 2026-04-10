import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintMemoryWikiVault } from "./lint.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("lintMemoryWikiVault", () => {
  it("detects duplicate ids, provenance gaps, contradictions, and open questions", async () => {
    const { rootDir, config } = await createVault({
      config: {
        vault: { renderMode: "obsidian" },
      },
      prefix: "memory-wiki-lint-",
    });
    await Promise.all(
      ["entities", "concepts", "sources", "syntheses"].map((dir) =>
        fs.mkdir(path.join(rootDir, dir), { recursive: true }),
      ),
    );

    const duplicate = renderWikiMarkdown({
      body: "# Alpha\n\n[[missing-page]]\n",
      frontmatter: {
        claims: [
          {
            confidence: 0.2,
            evidence: [],
            id: "claim.alpha.db",
            text: "Alpha uses PostgreSQL for production writes.",
          },
        ],
        confidence: 0.2,
        contradictions: ["Conflicts with source.beta"],
        id: "entity.alpha",
        pageType: "entity",
        questions: ["Is Alpha still active?"],
        title: "Alpha",
      },
    });
    await fs.writeFile(path.join(rootDir, "entities", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(path.join(rootDir, "concepts", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        body: "# Bridge Alpha\n",
        frontmatter: {
          id: "source.bridge.alpha",
          pageType: "source",
          sourceType: "memory-bridge",
          title: "Bridge Alpha",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-db.md"),
      renderWikiMarkdown({
        body: "# Alpha Database\n",
        frontmatter: {
          claims: [
            {
              confidence: 0.7,
              evidence: [
                {
                  sourceId: "source.bridge.alpha",
                  lines: "1-3",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
              id: "claim.alpha.db",
              status: "contested",
              text: "Alpha uses MySQL for production writes.",
            },
          ],
          id: "synthesis.alpha.db",
          pageType: "synthesis",
          sourceIds: ["source.bridge.alpha"],
          title: "Alpha Database",
          updatedAt: "2025-10-01T00:00:00.000Z",
        },
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issueCount).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate-id");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-source-ids");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-import-provenance");
    expect(result.issues.map((issue) => issue.code)).toContain("broken-wikilink");
    expect(result.issues.map((issue) => issue.code)).toContain("contradiction-present");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-conflict");
    expect(result.issues.map((issue) => issue.code)).toContain("open-question");
    expect(result.issues.map((issue) => issue.code)).toContain("low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-missing-evidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-page");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-claim");
    expect(
      result.issuesByCategory.contradictions.some((issue) => issue.code === "claim-conflict"),
    ).toBe(true);
    expect(result.issuesByCategory["open-questions"].length).toBeGreaterThanOrEqual(2);
    expect(
      result.issuesByCategory.provenance.some(
        (issue) => issue.code === "missing-import-provenance",
      ),
    ).toBe(true);
    expect(
      result.issuesByCategory.provenance.some((issue) => issue.code === "claim-missing-evidence"),
    ).toBe(true);
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Errors");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Contradictions");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Open Questions");
  });
});
