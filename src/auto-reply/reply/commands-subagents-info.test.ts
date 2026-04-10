import { beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { failTaskRunByRunId } from "../../tasks/task-executor.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import type { ReplyPayload } from "../types.js";
import { handleSubagentsInfoAction } from "./commands-subagents/action-info.js";

function buildInfoContext(params: { cfg: OpenClawConfig; runs: object[]; restTokens: string[] }) {
  return {
    handledPrefix: "/subagents",
    params: {
      cfg: params.cfg,
      sessionKey: "agent:main:main",
    },
    requesterKey: "agent:main:main",
    restTokens: params.restTokens,
    runs: params.runs,
  } as Parameters<typeof handleSubagentsInfoAction>[0];
}

function requireReplyText(reply: ReplyPayload | undefined): string {
  expect(reply?.text).toBeDefined();
  return reply?.text as string;
}

beforeEach(() => {
  resetTaskRegistryForTests();
  resetSubagentRegistryForTests();
});

describe("subagents info", () => {
  it("returns usage for missing targets", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction(buildInfoContext({ cfg, restTokens: [], runs: [] }));
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents info <id|#>");
  });

  it("returns info for a subagent", () => {
    const now = Date.now();
    const run = {
      childSessionKey: "agent:main:subagent:abc",
      cleanup: "keep",
      createdAt: now - 20_000,
      endedAt: now - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
      startedAt: now - 20_000,
      task: "do thing",
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    createTaskRecord({
      childSessionKey: "agent:main:subagent:abc",
      deliveryStatus: "delivered",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
      runtime: "subagent",
      status: "succeeded",
      task: "do thing",
      terminalSummary: "Completed the requested task",
    });
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg, restTokens: ["1"], runs: [run] }),
    );
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("Subagent info");
    expect(text).toContain("Run: run-1");
    expect(text).toContain("Status: done");
    expect(text).toContain("TaskStatus: succeeded");
    expect(text).toContain("Task summary: Completed the requested task");
  });

  it("sanitizes leaked task details in /subagents info", () => {
    const now = Date.now();
    const run = {
      childSessionKey: "agent:main:subagent:abc",
      cleanup: "keep",
      createdAt: now - 20_000,
      endedAt: now - 1000,
      outcome: {
        error: [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
        status: "error",
      },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
      startedAt: now - 20_000,
      task: "Inspect the stuck run",
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    createTaskRecord({
      childSessionKey: "agent:main:subagent:abc",
      deliveryStatus: "delivered",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
      runtime: "subagent",
      status: "running",
      task: "Inspect the stuck run",
    });
    failTaskRunByRunId({
      endedAt: now - 1000,
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      runId: "run-1",
      terminalSummary: "Needs manual follow-up.",
    });
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg, restTokens: ["1"], runs: [run] }),
    );
    const text = requireReplyText(result.reply);

    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("Subagent info");
    expect(text).toContain("Outcome: error");
    expect(text).toContain("Task summary: Needs manual follow-up.");
    expect(text).not.toContain("OpenClaw runtime context (internal):");
    expect(text).not.toContain("Internal task completion event");
  });
});
