import { describe, expect, it } from "vitest";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function makeBootstrapFile(overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile {
  return {
    content: "alpha",
    missing: false,
    name: "AGENTS.md",
    path: "/tmp/workspace/AGENTS.md",
    ...overrides,
  };
}

describe("buildSystemPromptReport", () => {
  const makeReport = (params: {
    file: WorkspaceBootstrapFile;
    injectedPath: string;
    injectedContent: string;
    bootstrapMaxChars?: number;
    bootstrapTotalMaxChars?: number;
  }) =>
    buildSystemPromptReport({
      bootstrapFiles: [params.file],
      bootstrapMaxChars: params.bootstrapMaxChars ?? 20_000,
      bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
      generatedAt: 0,
      injectedFiles: [{ content: params.injectedContent, path: params.injectedPath }],
      skillsPrompt: "",
      source: "run",
      systemPrompt: "system",
      tools: [],
    });

  it("counts injected chars when injected file paths are absolute", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedContent: "trimmed",
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("keeps legacy basename matching for injected files", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedContent: "trimmed",
      injectedPath: "AGENTS.md",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("marks workspace files truncated when injected chars are smaller than raw chars", () => {
    const file = makeBootstrapFile({
      content: "abcdefghijklmnopqrstuvwxyz",
      path: "/tmp/workspace/policies/AGENTS.md",
    });
    const report = makeReport({
      file,
      injectedContent: "trimmed",
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
    });

    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("includes both bootstrap caps in the report payload", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      bootstrapMaxChars: 11_111,
      bootstrapTotalMaxChars: 22_222,
      file,
      injectedContent: "trimmed",
      injectedPath: "AGENTS.md",
    });

    expect(report.bootstrapMaxChars).toBe(11_111);
    expect(report.bootstrapTotalMaxChars).toBe(22_222);
  });

  it("reports zero in-band tool list chars when tool info stays structured", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedContent: "trimmed",
      injectedPath: "AGENTS.md",
    });

    expect(report.tools.listChars).toBe(0);
  });

  it("reports injectedChars=0 when injected file does not match by path or basename", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedContent: "trimmed",
      injectedPath: "/tmp/workspace/policies/OTHER.md",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe(0);
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("ignores malformed injected file paths and still matches valid entries", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = buildSystemPromptReport({
      bootstrapFiles: [file],
      bootstrapMaxChars: 20_000,
      generatedAt: 0,
      injectedFiles: [
        { content: "bad", path: 123 as unknown as string },
        { content: "trimmed", path: "/tmp/workspace/policies/AGENTS.md" },
      ],
      skillsPrompt: "",
      source: "run",
      systemPrompt: "system",
      tools: [],
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });
});
