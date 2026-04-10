import { describe, expect, it } from "vitest";
import {
  analyzeBootstrapBudget,
  appendBootstrapPromptWarning,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  buildBootstrapTruncationSignature,
  formatBootstrapTruncationWarningLines,
  resolveBootstrapWarningSignaturesSeen,
} from "./bootstrap-budget.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

describe("buildBootstrapInjectionStats", () => {
  it("maps raw and injected sizes and marks truncation", () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      {
        content: "a".repeat(100),
        missing: false,
        name: "AGENTS.md",
        path: "/tmp/AGENTS.md",
      },
      {
        content: "b".repeat(50),
        missing: false,
        name: "SOUL.md",
        path: "/tmp/SOUL.md",
      },
    ];
    const injectedFiles = [
      { content: "a".repeat(100), path: "/tmp/AGENTS.md" },
      { content: "b".repeat(20), path: "/tmp/SOUL.md" },
    ];
    const stats = buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles,
    });
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      injectedChars: 100,
      name: "AGENTS.md",
      rawChars: 100,
      truncated: false,
    });
    expect(stats[1]).toMatchObject({
      injectedChars: 20,
      name: "SOUL.md",
      rawChars: 50,
      truncated: true,
    });
  });
});

describe("analyzeBootstrapBudget", () => {
  it("reports per-file and total-limit causes", () => {
    const analysis = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 120,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          rawChars: 150,
          truncated: true,
        },
        {
          injectedChars: 80,
          missing: false,
          name: "SOUL.md",
          path: "/tmp/SOUL.md",
          rawChars: 90,
          truncated: true,
        },
      ],
    });
    expect(analysis.hasTruncation).toBe(true);
    expect(analysis.totalNearLimit).toBe(true);
    expect(analysis.truncatedFiles).toHaveLength(2);
    const agents = analysis.truncatedFiles.find((file) => file.name === "AGENTS.md");
    const soul = analysis.truncatedFiles.find((file) => file.name === "SOUL.md");
    expect(agents?.causes).toContain("per-file-limit");
    expect(agents?.causes).toContain("total-limit");
    expect(soul?.causes).toContain("total-limit");
  });

  it("does not force a total-limit cause when totals are within limits", () => {
    const analysis = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 40,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          rawChars: 90,
          truncated: true,
        },
      ],
    });
    expect(analysis.truncatedFiles[0]?.causes).toEqual([]);
  });
});

describe("bootstrap prompt warnings", () => {
  it("appends warning details to the turn prompt instead of mutating the system prompt", () => {
    const prompt = appendBootstrapPromptWarning("Please continue.", [
      "AGENTS.md: 200 raw -> 0 injected",
    ]);
    expect(prompt.startsWith("Please continue.")).toBe(true);
    expect(prompt).toContain("[Bootstrap truncation warning]");
    expect(prompt).toContain("Treat Project Context as partial");
    expect(prompt).toContain("- AGENTS.md: 200 raw -> 0 injected");
    expect(prompt.endsWith("- AGENTS.md: 200 raw -> 0 injected")).toBe(true);
  });

  it("preserves raw prompt whitespace when appending warning details", () => {
    const prompt = appendBootstrapPromptWarning("  indented\nkeep tail  ", [
      "AGENTS.md: 200 raw -> 0 injected",
    ]);

    expect(prompt).toContain("  indented\nkeep tail  ");
    expect(prompt.indexOf("  indented\nkeep tail  ")).toBe(0);
  });

  it("preserves exact heartbeat prompts without warning suffixes", () => {
    const heartbeatPrompt = "Read HEARTBEAT.md. Reply HEARTBEAT_OK.";

    expect(
      appendBootstrapPromptWarning(heartbeatPrompt, ["AGENTS.md: 200 raw -> 0 injected"], {
        preserveExactPrompt: heartbeatPrompt,
      }),
    ).toBe(heartbeatPrompt);
  });

  it("resolves seen signatures from report history or legacy single signature", () => {
    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          promptWarningSignature: "legacy-ignored",
          warningSignaturesSeen: ["sig-a", " ", "sig-b", "sig-a"],
        },
      }),
    ).toEqual(["sig-a", "sig-b"]);

    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          promptWarningSignature: "legacy-only",
        },
      }),
    ).toEqual(["legacy-only"]);

    expect(resolveBootstrapWarningSignaturesSeen(undefined)).toEqual([]);
  });

  it("ignores single-signature fallback when warning mode is off", () => {
    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          promptWarningSignature: "off-mode-signature",
          warningMode: "off",
        },
      }),
    ).toEqual([]);

    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          promptWarningSignature: "off-mode-signature",
          warningMode: "off",
          warningSignaturesSeen: ["prior-once-signature"],
        },
      }),
    ).toEqual(["prior-once-signature"]);
  });

  it("dedupes warnings in once mode by signature", () => {
    const analysis = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          rawChars: 150,
          truncated: true,
        },
      ],
    });
    const first = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    expect(first.warningShown).toBe(true);
    expect(first.signature).toBeTruthy();
    expect(first.lines.join("\n")).toContain("AGENTS.md");

    const second = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
      seenSignatures: first.warningSignaturesSeen,
    });
    expect(second.warningShown).toBe(false);
    expect(second.lines).toEqual([]);
  });

  it("dedupes once mode across non-consecutive repeated signatures", () => {
    const analysisA = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "A.md",
          path: "/tmp/A.md",
          rawChars: 150,
          truncated: true,
        },
      ],
    });
    const analysisB = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "B.md",
          path: "/tmp/B.md",
          rawChars: 150,
          truncated: true,
        },
      ],
    });
    const firstA = buildBootstrapPromptWarning({
      analysis: analysisA,
      mode: "once",
    });
    expect(firstA.warningShown).toBe(true);
    const firstB = buildBootstrapPromptWarning({
      analysis: analysisB,
      mode: "once",
      seenSignatures: firstA.warningSignaturesSeen,
    });
    expect(firstB.warningShown).toBe(true);
    const secondA = buildBootstrapPromptWarning({
      analysis: analysisA,
      mode: "once",
      seenSignatures: firstB.warningSignaturesSeen,
    });
    expect(secondA.warningShown).toBe(false);
  });

  it("includes overflow line when more files are truncated than shown", () => {
    const analysis = analyzeBootstrapBudget({
      bootstrapMaxChars: 20,
      bootstrapTotalMaxChars: 10,
      files: [
        {
          injectedChars: 1,
          missing: false,
          name: "A.md",
          path: "/tmp/A.md",
          rawChars: 10,
          truncated: true,
        },
        {
          injectedChars: 1,
          missing: false,
          name: "B.md",
          path: "/tmp/B.md",
          rawChars: 10,
          truncated: true,
        },
        {
          injectedChars: 1,
          missing: false,
          name: "C.md",
          path: "/tmp/C.md",
          rawChars: 10,
          truncated: true,
        },
      ],
    });
    const lines = formatBootstrapTruncationWarningLines({
      analysis,
      maxFiles: 2,
    });
    expect(lines).toContain("+1 more truncated file(s).");
  });

  it("disambiguates duplicate file names in warning lines", () => {
    const analysis = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 300,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/a/AGENTS.md",
          rawChars: 150,
          truncated: true,
        },
        {
          injectedChars: 100,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/b/AGENTS.md",
          rawChars: 140,
          truncated: true,
        },
      ],
    });
    const lines = formatBootstrapTruncationWarningLines({
      analysis,
    });
    expect(lines.join("\n")).toContain("AGENTS.md (/tmp/a/AGENTS.md)");
    expect(lines.join("\n")).toContain("AGENTS.md (/tmp/b/AGENTS.md)");
  });

  it("respects off/always warning modes", () => {
    const analysis = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          rawChars: 150,
          truncated: true,
        },
      ],
    });
    const signature = buildBootstrapTruncationSignature(analysis);
    const off = buildBootstrapPromptWarning({
      analysis,
      mode: "off",
      previousSignature: signature,
      seenSignatures: [signature ?? ""],
    });
    expect(off.warningShown).toBe(false);
    expect(off.lines).toEqual([]);

    const always = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
      previousSignature: signature,
      seenSignatures: [signature ?? ""],
    });
    expect(always.warningShown).toBe(true);
    expect(always.lines.length).toBeGreaterThan(0);
  });

  it("uses file path in signature to avoid collisions for duplicate names", () => {
    const left = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/a/AGENTS.md",
          rawChars: 150,
          truncated: true,
        },
      ],
    });
    const right = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/b/AGENTS.md",
          rawChars: 150,
          truncated: true,
        },
      ],
    });
    expect(buildBootstrapTruncationSignature(left)).not.toBe(
      buildBootstrapTruncationSignature(right),
    );
  });

  it("builds truncation report metadata from analysis + warning decision", () => {
    const analysis = analyzeBootstrapBudget({
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
      files: [
        {
          injectedChars: 100,
          missing: false,
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          rawChars: 150,
          truncated: true,
        },
      ],
    });
    const warning = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const meta = buildBootstrapTruncationReportMeta({
      analysis,
      warning,
      warningMode: "once",
    });
    expect(meta.warningMode).toBe("once");
    expect(meta.warningShown).toBe(true);
    expect(meta.truncatedFiles).toBe(1);
    expect(meta.nearLimitFiles).toBeGreaterThanOrEqual(1);
    expect(meta.promptWarningSignature).toBeTruthy();
    expect(meta.warningSignaturesSeen?.length).toBeGreaterThan(0);
  });

  it("improves cache-relevant system prompt stability versus legacy warning injection", () => {
    const contextFiles = [{ content: "Follow AGENTS guidance.", path: "AGENTS.md" }];
    const warningLines = ["AGENTS.md: 200 raw -> 0 injected"];
    const stableSystemPrompt = buildAgentSystemPrompt({
      contextFiles,
      workspaceDir: "/tmp/openclaw",
    });
    const optimizedTurns = [stableSystemPrompt, stableSystemPrompt, stableSystemPrompt];
    const injectLegacyWarning = (prompt: string, lines: string[]) => {
      const warningBlock = [
        "⚠ Bootstrap truncation warning:",
        ...lines.map((line) => `- ${line}`),
        "",
      ].join("\n");
      return prompt.replace("## AGENTS.md", `${warningBlock}## AGENTS.md`);
    };
    const legacyTurns = [
      injectLegacyWarning(optimizedTurns[0] ?? "", warningLines),
      optimizedTurns[1] ?? "",
      injectLegacyWarning(optimizedTurns[2] ?? "", warningLines),
    ];
    const cacheHitRate = (turns: string[]) => {
      const hits = turns.slice(1).filter((turn, index) => turn === turns[index]).length;
      return hits / Math.max(1, turns.length - 1);
    };

    expect(cacheHitRate(legacyTurns)).toBe(0);
    expect(cacheHitRate(optimizedTurns)).toBe(1);
    expect(optimizedTurns[0]).not.toContain("⚠ Bootstrap truncation warning:");
  });
});
