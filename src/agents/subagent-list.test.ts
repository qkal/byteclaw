import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { buildSubagentList } from "./subagent-list.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-list-"));
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 50,
  });
});

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe("buildSubagentList", () => {
  it("returns empty active and recent sections when no runs exist", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      recentMinutes: 30,
      runs: [],
      taskMaxChars: 110,
    });
    expect(list.active).toEqual([]);
    expect(list.recent).toEqual([]);
    expect(list.text).toContain("active subagents:");
    expect(list.text).toContain("recent (last 30m):");
  });

  it("truncates long task text in list lines", () => {
    const run = {
      childSessionKey: "agent:main:subagent:long-task",
      cleanup: "keep",
      createdAt: 1000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-long-task",
      startedAt: 1000,
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      recentMinutes: 30,
      runs: [run],
      taskMaxChars: 110,
    });
    expect(list.active[0]?.line).toContain(
      "This is a deliberately long task description used to verify that subagent list output keeps the full task text",
    );
    expect(list.active[0]?.line).toContain("...");
    expect(list.active[0]?.line).not.toContain("after a short hard cutoff.");
  });

  it("keeps ended orchestrators active while descendants remain pending", () => {
    const now = Date.now();
    const orchestratorRun = {
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      cleanup: "keep",
      createdAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-orchestrator-ended",
      startedAt: now - 120_000,
      task: "orchestrate child workers",
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(orchestratorRun);
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      cleanup: "keep",
      createdAt: now - 30_000,
      requesterDisplayKey: "subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      runId: "run-orchestrator-child-active",
      startedAt: now - 30_000,
      task: "child worker still running",
    });
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      recentMinutes: 30,
      runs: [orchestratorRun],
      taskMaxChars: 110,
    });

    expect(list.active[0]?.status).toBe("active (waiting on 1 child)");
    expect(list.recent).toEqual([]);
  });

  it("formats io and prompt/cache usage from session entries", async () => {
    const run = {
      childSessionKey: "agent:main:subagent:usage",
      cleanup: "keep",
      createdAt: 1000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-usage",
      startedAt: 1000,
      task: "do thing",
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);
    const storePath = path.join(testWorkspaceDir, "sessions-subagent-list-usage.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:usage"] = {
        inputTokens: 12,
        model: "opencode/claude-opus-4-6",
        outputTokens: 1000,
        sessionId: "child-session-usage",
        totalTokens: 197_000,
        updatedAt: Date.now(),
      };
    });
    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
      session: { store: storePath },
    } as OpenClawConfig;
    const list = buildSubagentList({
      cfg,
      recentMinutes: 30,
      runs: [run],
      taskMaxChars: 110,
    });

    expect(list.active[0]?.line).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
    expect(list.active[0]?.line).toContain("prompt/cache 197k");
    expect(list.active[0]?.line).not.toContain("1k io");
  });
});
