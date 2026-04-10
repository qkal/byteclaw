import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

async function resolveBridgeMissingArtifactsStatus() {
  const config = resolveMemoryWikiConfig(
    {
      bridge: {
        enabled: true,
        readMemoryArtifacts: true,
      },
      vaultMode: "bridge",
    },
    { homedir: "/Users/tester" },
  );

  return resolveMemoryWikiStatus(config, {
    appConfig: {
      agents: {
        list: [{ default: true, id: "main", workspace: "/tmp/workspace" }],
      },
    } as OpenClawConfig,
    listPublicArtifacts: async () => [],
    pathExists: async () => true,
    resolveCommand: async () => null,
  });
}

describe("resolveMemoryWikiStatus", () => {
  it("reports missing vault and missing requested obsidian cli", async () => {
    const config = resolveMemoryWikiConfig(
      {
        obsidian: { enabled: true, useOfficialCli: true },
        vault: { path: "/tmp/wiki" },
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => false,
      resolveCommand: async () => null,
    });

    expect(status.vaultExists).toBe(false);
    expect(status.obsidianCli.requested).toBe(true);
    expect(status.warnings.map((warning) => warning.code)).toEqual([
      "vault-missing",
      "obsidian-cli-missing",
    ]);
    expect(status.sourceCounts).toEqual({
      bridge: 0,
      bridgeEvents: 0,
      native: 0,
      other: 0,
      unsafeLocal: 0,
    });
  });

  it("warns when unsafe-local is selected without explicit private access", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "unsafe-local",
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => "/usr/local/bin/obsidian",
    });

    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });

  it("warns when bridge mode has no exported memory artifacts", async () => {
    const status = await resolveBridgeMissingArtifactsStatus();

    expect(status.bridgePublicArtifactCount).toBe(0);
    expect(status.warnings.map((warning) => warning.code)).toContain("bridge-artifacts-missing");
  });

  it("counts source provenance from the vault", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      prefix: "memory-wiki-status-",
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "native.md"),
      renderWikiMarkdown({
        body: "# Native Source\n",
        frontmatter: { id: "source.native", pageType: "source", title: "Native Source" },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge.md"),
      renderWikiMarkdown({
        body: "# Bridge Source\n",
        frontmatter: {
          id: "source.bridge",
          pageType: "source",
          sourceType: "memory-bridge",
          title: "Bridge Source",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "events.md"),
      renderWikiMarkdown({
        body: "# Event Source\n",
        frontmatter: {
          id: "source.events",
          pageType: "source",
          sourceType: "memory-bridge-events",
          title: "Event Source",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe.md"),
      renderWikiMarkdown({
        body: "# Unsafe Source\n",
        frontmatter: {
          id: "source.unsafe",
          pageType: "source",
          provenanceMode: "unsafe-local",
          sourceType: "memory-unsafe-local",
          title: "Unsafe Source",
        },
      }),
      "utf8",
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => null,
    });

    expect(status.pageCounts.source).toBe(4);
    expect(status.sourceCounts).toEqual({
      bridge: 1,
      bridgeEvents: 1,
      native: 1,
      other: 0,
      unsafeLocal: 1,
    });
  });
});

describe("renderMemoryWikiStatus", () => {
  it("includes warnings in the text output", () => {
    const rendered = renderMemoryWikiStatus({
      bridge: {
        enabled: false,
        followMemoryEvents: true,
        indexDailyNotes: true,
        indexDreamReports: true,
        indexMemoryRoot: true,
        readMemoryArtifacts: true,
      },
      bridgePublicArtifactCount: null,
      obsidianCli: {
        available: false,
        command: null,
        enabled: true,
        requested: true,
      },
      pageCounts: {
        concept: 0,
        entity: 0,
        report: 0,
        source: 0,
        synthesis: 0,
      },
      renderMode: "native",
      sourceCounts: {
        bridge: 0,
        bridgeEvents: 0,
        native: 0,
        other: 0,
        unsafeLocal: 0,
      },
      unsafeLocal: {
        allowPrivateMemoryCoreAccess: false,
        pathCount: 0,
      },
      vaultExists: false,
      vaultMode: "isolated",
      vaultPath: "/tmp/wiki",
      warnings: [{ code: "vault-missing", message: "Wiki vault has not been initialized yet." }],
    });

    expect(rendered).toContain("Wiki vault mode: isolated");
    expect(rendered).toContain("Pages: 0 sources, 0 entities, 0 concepts, 0 syntheses, 0 reports");
    expect(rendered).toContain(
      "Source provenance: 0 native, 0 bridge, 0 bridge-events, 0 unsafe-local, 0 other",
    );
    expect(rendered).toContain("Warnings:");
    expect(rendered).toContain("Wiki vault has not been initialized yet.");
  });
});

describe("memory wiki doctor", () => {
  it("builds actionable fixes from status warnings", async () => {
    const config = resolveMemoryWikiConfig(
      {
        obsidian: { enabled: true, useOfficialCli: true },
        vault: { path: "/tmp/wiki" },
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => false,
      resolveCommand: async () => null,
    });
    const report = buildMemoryWikiDoctorReport(status);
    const rendered = renderMemoryWikiDoctor(report);

    expect(report.healthy).toBe(false);
    expect(report.warningCount).toBe(2);
    expect(report.fixes.map((fix) => fix.code)).toEqual(["vault-missing", "obsidian-cli-missing"]);
    expect(rendered).toContain("Suggested fixes:");
    expect(rendered).toContain("openclaw wiki init");
  });

  it("suggests bridge fixes when no public artifacts are exported", async () => {
    const status = await resolveBridgeMissingArtifactsStatus();
    const report = buildMemoryWikiDoctorReport(status);

    expect(report.fixes.map((fix) => fix.code)).toContain("bridge-artifacts-missing");
    expect(renderMemoryWikiDoctor(report)).toContain("exports public artifacts");
  });
});
