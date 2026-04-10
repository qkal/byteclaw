import { describe, expect, it } from "vitest";
import { buildContextReply } from "./commands-context-report.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(
  commandBodyNormalized: string,
  truncated: boolean,
  options?: {
    omitBootstrapLimits?: boolean;
    contextTokens?: number | null;
    totalTokens?: number | null;
    totalTokensFresh?: boolean;
  },
): HandleCommandsParams {
  return {
    cfg: {},
    command: {
      channel: "telegram",
      commandBodyNormalized,
      senderIsOwner: true,
    },
    commandArgs: [],
    commandBody: "",
    contextTokens: options?.contextTokens ?? null,
    ctx: {},
    elevated: { allowed: false },
    model: "gpt-5",
    provider: "openai",
    resolvedElevatedLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedThinkLevel: "off",
    sessionEntry: {
      inputTokens: 100,
      outputTokens: 23,
      systemPromptReport: {
        bootstrapMaxChars: options?.omitBootstrapLimits ? undefined : 20_000,
        bootstrapTotalMaxChars: options?.omitBootstrapLimits ? undefined : 150_000,
        generatedAt: Date.now(),
        injectedWorkspaceFiles: [
          {
            injectedChars: truncated ? 20_000 : 10_000,
            missing: false,
            name: "AGENTS.md",
            path: "/tmp/workspace/AGENTS.md",
            rawChars: truncated ? 200_000 : 10_000,
            truncated,
          },
        ],
        sandbox: { mode: "off", sandboxed: false },
        skills: {
          entries: [{ blockChars: 10, name: "checks" }],
          promptChars: 10,
        },
        source: "run",
        systemPrompt: {
          chars: 1000,
          nonProjectContextChars: 500,
          projectContextChars: 500,
        },
        tools: {
          entries: [{ name: "read", propertiesCount: 1, schemaChars: 20, summaryChars: 10 }],
          listChars: 10,
          schemaChars: 20,
        },
        workspaceDir: "/tmp/workspace",
      },
      totalTokens: options?.totalTokens ?? 123,
      totalTokensFresh: options?.totalTokensFresh ?? true,
    },
    sessionKey: "agent:default:main",
    workspaceDir: "/tmp/workspace",
  } as unknown as HandleCommandsParams;
}

describe("buildContextReply", () => {
  it("shows bootstrap truncation warning in list output when context exceeds configured limits", async () => {
    const result = await buildContextReply(makeParams("/context list", true));
    expect(result.text).toContain("Bootstrap max/total: 150,000 chars");
    expect(result.text).toContain("⚠ Bootstrap context is over configured limits");
    expect(result.text).toContain("Causes: 1 file(s) exceeded max/file.");
  });

  it("does not show bootstrap truncation warning when there is no truncation", async () => {
    const result = await buildContextReply(makeParams("/context list", false));
    expect(result.text).not.toContain("Bootstrap context is over configured limits");
  });

  it("falls back to config defaults when legacy reports are missing bootstrap limits", async () => {
    const result = await buildContextReply(
      makeParams("/context list", false, {
        omitBootstrapLimits: true,
      }),
    );
    expect(result.text).toContain("Bootstrap max/file: 20,000 chars");
    expect(result.text).toContain("Bootstrap max/total: 150,000 chars");
    expect(result.text).not.toContain("Bootstrap max/file: ? chars");
  });

  it("shows tracked estimate and cached context delta in detail output", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, {
        contextTokens: 8192,
        totalTokens: 900,
      }),
    );
    expect(result.text).toContain("Tracked prompt estimate: 1,020 chars (~255 tok)");
    expect(result.text).toContain("Actual context usage (cached): 900 tok");
    expect(result.text).toContain("Untracked provider/runtime overhead: ~645 tok");
    expect(result.text).toContain("Session tokens (cached): 900 total / ctx=8,192");
  });

  it("shows estimate-only detail output when cached context usage is unavailable", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, {
        contextTokens: 8192,
        totalTokens: 900,
        totalTokensFresh: false,
      }),
    );
    expect(result.text).toContain("Tracked prompt estimate: 1,020 chars (~255 tok)");
    expect(result.text).toContain("Actual context usage (cached): unavailable");
    expect(result.text).toContain("Session tokens (cached): unknown / ctx=8,192");
    expect(result.text).not.toContain("~645 tok");
  });
});
