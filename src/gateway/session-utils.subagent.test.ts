import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnv } from "../test-utils/env.js";
import {
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  resolveGatewayModelSupportsImages,
} from "./session-utils.js";

describe("listSessionsFromStore subagent metadata", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  const cfg = {
    agents: { list: [{ default: true, id: "main" }] },
    session: { mainKey: "main" },
  } as OpenClawConfig;

  test("includes subagent status timing and direct child session keys", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:child": {
        forkedFromParent: true,
        sessionId: "sess-child",
        spawnDepth: 2,
        spawnedBy: "agent:main:subagent:parent",
        spawnedWorkspaceDir: "/tmp/child-workspace",
        subagentControlScope: "children",
        subagentRole: "orchestrator",
        updatedAt: now - 1_000,
      } as SessionEntry,
      "agent:main:subagent:failed": {
        sessionId: "sess-failed",
        spawnedBy: "agent:main:main",
        updatedAt: now - 500,
      } as SessionEntry,
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        spawnedBy: "agent:main:main",
        updatedAt: now - 2_000,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:parent",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      model: "openai/gpt-5.4",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-parent",
      startedAt: now - 9000,
      task: "parent task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:child",
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:parent",
      createdAt: now - 8000,
      endedAt: now - 2500,
      model: "openai/gpt-5.4",
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-child",
      startedAt: now - 7500,
      task: "child task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:failed",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 6000,
      endedAt: now - 500,
      model: "openai/gpt-5.4",
      outcome: { error: "boom", status: "error" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-failed",
      startedAt: now - 5500,
      task: "failed task",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([
      "agent:main:subagent:parent",
      "agent:main:subagent:failed",
    ]);
    expect(main?.status).toBeUndefined();

    const parent = result.sessions.find((session) => session.key === "agent:main:subagent:parent");
    expect(parent?.status).toBe("running");
    expect(parent?.startedAt).toBe(now - 9000);
    expect(parent?.endedAt).toBeUndefined();
    expect(parent?.runtimeMs).toBeGreaterThanOrEqual(9000);
    expect(parent?.childSessions).toEqual(["agent:main:subagent:child"]);

    const child = result.sessions.find((session) => session.key === "agent:main:subagent:child");
    expect(child?.status).toBe("done");
    expect(child?.startedAt).toBe(now - 7500);
    expect(child?.endedAt).toBe(now - 2500);
    expect(child?.runtimeMs).toBe(5000);
    expect(child?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
    expect(child?.forkedFromParent).toBe(true);
    expect(child?.spawnDepth).toBe(2);
    expect(child?.subagentRole).toBe("orchestrator");
    expect(child?.subagentControlScope).toBe("children");
    expect(child?.childSessions).toBeUndefined();

    const failed = result.sessions.find((session) => session.key === "agent:main:subagent:failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.runtimeMs).toBe(5000);
  });

  test("does not keep childSessions attached to a stale older controller row", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:new-parent": {
        sessionId: "sess-new-parent",
        spawnedBy: "agent:main:main",
        updatedAt: now - 3_000,
      } as SessionEntry,
      "agent:main:subagent:old-parent": {
        sessionId: "sess-old-parent",
        spawnedBy: "agent:main:main",
        updatedAt: now - 4_000,
      } as SessionEntry,
      "agent:main:subagent:shared-child": {
        sessionId: "sess-shared-child",
        spawnedBy: "agent:main:subagent:new-parent",
        updatedAt: now - 1_000,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:old-parent",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-old-parent",
      startedAt: now - 9000,
      task: "old parent task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:new-parent",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 8000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-new-parent",
      startedAt: now - 7000,
      task: "new parent task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:shared-child",
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:old-parent",
      createdAt: now - 6000,
      endedAt: now - 4500,
      outcome: { status: "ok" },
      requesterDisplayKey: "old-parent",
      requesterSessionKey: "agent:main:subagent:old-parent",
      runId: "run-child-stale-parent",
      startedAt: now - 5500,
      task: "shared child stale parent",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:shared-child",
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:new-parent",
      createdAt: now - 2000,
      requesterDisplayKey: "new-parent",
      requesterSessionKey: "agent:main:subagent:new-parent",
      runId: "run-child-current-parent",
      startedAt: now - 1500,
      task: "shared child current parent",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child"]);
  });

  test("does not reattach moved children through stale spawnedBy store metadata", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:new-parent-store": {
        sessionId: "sess-new-parent-store",
        spawnedBy: "agent:main:main",
        updatedAt: now - 3_000,
      } as SessionEntry,
      "agent:main:subagent:old-parent-store": {
        sessionId: "sess-old-parent-store",
        spawnedBy: "agent:main:main",
        updatedAt: now - 4_000,
      } as SessionEntry,
      "agent:main:subagent:shared-child-store": {
        sessionId: "sess-shared-child-store",
        spawnedBy: "agent:main:subagent:old-parent-store",
        updatedAt: now - 1_000,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:old-parent-store",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-old-parent-store",
      startedAt: now - 9000,
      task: "old parent store task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:new-parent-store",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 8000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-new-parent-store",
      startedAt: now - 7000,
      task: "new parent store task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:shared-child-store",
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:old-parent-store",
      createdAt: now - 6000,
      endedAt: now - 4500,
      outcome: { status: "ok" },
      requesterDisplayKey: "old-parent-store",
      requesterSessionKey: "agent:main:subagent:old-parent-store",
      runId: "run-child-store-stale-parent",
      startedAt: now - 5500,
      task: "shared child stale store parent",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:shared-child-store",
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:new-parent-store",
      createdAt: now - 2000,
      requesterDisplayKey: "new-parent-store",
      requesterSessionKey: "agent:main:subagent:new-parent-store",
      runId: "run-child-store-current-parent",
      startedAt: now - 1500,
      task: "shared child current store parent",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent-store",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent-store",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child-store"]);
  });

  test("does not return moved child sessions from stale spawnedBy filters", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:new-parent-filter": {
        sessionId: "sess-new-parent-filter",
        spawnedBy: "agent:main:main",
        updatedAt: now - 3_000,
      } as SessionEntry,
      "agent:main:subagent:old-parent-filter": {
        sessionId: "sess-old-parent-filter",
        spawnedBy: "agent:main:main",
        updatedAt: now - 4_000,
      } as SessionEntry,
      "agent:main:subagent:shared-child-filter": {
        sessionId: "sess-shared-child-filter",
        spawnedBy: "agent:main:subagent:old-parent-filter",
        updatedAt: now - 1_000,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:old-parent-filter",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-old-parent-filter",
      startedAt: now - 9000,
      task: "old parent filter task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:new-parent-filter",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 8000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-new-parent-filter",
      startedAt: now - 7000,
      task: "new parent filter task",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:shared-child-filter",
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:old-parent-filter",
      createdAt: now - 6000,
      endedAt: now - 4500,
      outcome: { status: "ok" },
      requesterDisplayKey: "old-parent-filter",
      requesterSessionKey: "agent:main:subagent:old-parent-filter",
      runId: "run-child-filter-stale-parent",
      startedAt: now - 5500,
      task: "shared child stale filter parent",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:shared-child-filter",
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:new-parent-filter",
      createdAt: now - 2000,
      requesterDisplayKey: "new-parent-filter",
      requesterSessionKey: "agent:main:subagent:new-parent-filter",
      runId: "run-child-filter-current-parent",
      startedAt: now - 1500,
      task: "shared child current filter parent",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {
        spawnedBy: "agent:main:subagent:old-parent-filter",
      },
      store,
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions.map((session) => session.key)).toEqual([]);
  });

  test("reports the newest run owner for moved child session rows", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-owner";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-owner",
        spawnedBy: "agent:main:subagent:old-parent-owner",
        updatedAt: now,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:old-parent-owner",
      createdAt: now - 6000,
      endedAt: now - 4500,
      outcome: { status: "ok" },
      requesterDisplayKey: "old-parent-owner",
      requesterSessionKey: "agent:main:subagent:old-parent-owner",
      runId: "run-child-owner-stale-parent",
      startedAt: now - 5500,
      task: "shared child stale owner parent",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:new-parent-owner",
      createdAt: now - 2000,
      requesterDisplayKey: "new-parent-owner",
      requesterSessionKey: "agent:main:subagent:new-parent-owner",
      runId: "run-child-owner-current-parent",
      startedAt: now - 1500,
      task: "shared child current owner parent",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      spawnedBy: "agent:main:subagent:new-parent-owner",
    });
  });

  test("reports the newest parentSessionKey for moved child session rows", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-parent";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        parentSessionKey: "agent:main:subagent:old-parent-parent",
        sessionId: "sess-shared-child-parent",
        updatedAt: now,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:old-parent-parent",
      createdAt: now - 6000,
      endedAt: now - 4500,
      outcome: { status: "ok" },
      requesterDisplayKey: "old-parent-parent",
      requesterSessionKey: "agent:main:subagent:old-parent-parent",
      runId: "run-child-parent-stale-parent",
      startedAt: now - 5500,
      task: "shared child stale parentSessionKey parent",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:subagent:new-parent-parent",
      createdAt: now - 2000,
      requesterDisplayKey: "new-parent-parent",
      requesterSessionKey: "agent:main:subagent:new-parent-parent",
      runId: "run-child-parent-current-parent",
      startedAt: now - 1500,
      task: "shared child current parentSessionKey parent",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      parentSessionKey: "agent:main:subagent:new-parent-parent",
    });
  });

  test("preserves original session timing across follow-up replacement runs", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:followup": {
        sessionId: "sess-followup",
        spawnedBy: "agent:main:main",
        updatedAt: now,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      accumulatedRuntimeMs: 120_000,
      childSessionKey: "agent:main:subagent:followup",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      model: "openai/gpt-5.4",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-followup-new",
      sessionStartedAt: now - 150_000,
      startedAt: now - 30_000,
      task: "follow-up task",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const followup = result.sessions.find(
      (session) => session.key === "agent:main:subagent:followup",
    );
    expect(followup?.status).toBe("running");
    expect(followup?.startedAt).toBe(now - 150_000);
    expect(followup?.runtimeMs).toBeGreaterThanOrEqual(150_000);
  });

  test("uses the newest child-session row for stale/current replacement pairs", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-current";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-current",
        spawnedBy: "agent:main:main",
        updatedAt: now,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 5000,
      model: "openai/gpt-5.4",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-stale-active",
      startedAt: now - 4500,
      task: "stale active row",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 1000,
      endedAt: now - 200,
      model: "openai/gpt-5.4",
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-ended",
      startedAt: now - 900,
      task: "current ended row",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      endedAt: now - 200,
      key: childSessionKey,
      startedAt: now - 900,
      status: "done",
    });
  });

  test("uses persisted active subagent runs when the local worker only has terminal snapshots", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:disk-live";
      const registryPath = path.join(stateDir, "subagents", "runs.json");
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(
        registryPath,
        JSON.stringify(
          {
            runs: {
              "run-complete": {
                childSessionKey,
                cleanup: "keep",
                createdAt: now - 2000,
                endedAt: now - 1800,
                outcome: { status: "ok" },
                requesterDisplayKey: "main",
                requesterSessionKey: "agent:main:main",
                runId: "run-complete",
                startedAt: now - 1900,
                task: "finished too early",
              },
              "run-live": {
                childSessionKey,
                cleanup: "keep",
                createdAt: now - 10_000,
                requesterDisplayKey: "main",
                requesterSessionKey: "agent:main:main",
                runId: "run-live",
                startedAt: now - 9000,
                task: "still running",
              },
            },
            version: 2,
          },
          null,
          2,
        ),
        "utf8",
      );

      const row = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
        },
        () => {
          const result = listSessionsFromStore({
            cfg,
            opts: {},
            store: {
              [childSessionKey]: {
                endedAt: now - 1_800,
                runtimeMs: 100,
                sessionId: "sess-disk-live",
                spawnedBy: "agent:main:main",
                status: "done",
                updatedAt: now,
              } as SessionEntry,
            },
            storePath: "/tmp/sessions.json",
          });
          return result.sessions.find((session) => session.key === childSessionKey);
        },
      );

      expect(row?.status).toBe("running");
      expect(row?.startedAt).toBe(now - 9000);
      expect(row?.endedAt).toBeUndefined();
      expect(row?.runtimeMs).toBeGreaterThanOrEqual(9000);
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  test("includes explicit parentSessionKey relationships for dashboard child sessions", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:dashboard:child": {
        parentSessionKey: "agent:main:main",
        sessionId: "sess-child",
        updatedAt: now - 1_000,
      } as SessionEntry,
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    const child = result.sessions.find((session) => session.key === "agent:main:dashboard:child");
    expect(main?.childSessions).toEqual(["agent:main:dashboard:child"]);
    expect(child?.parentSessionKey).toBe("agent:main:main");
  });

  test("returns dashboard child sessions when filtering by parentSessionKey owner", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:dashboard:child": {
        parentSessionKey: "agent:main:main",
        sessionId: "sess-dashboard-child",
        updatedAt: now - 1_000,
      } as SessionEntry,
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      opts: {
        spawnedBy: "agent:main:main",
      },
      store,
      storePath: "/tmp/sessions.json",
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:dashboard:child"]);
  });

  test("falls back to persisted subagent timing after run archival", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:archived": {
        endedAt: now - 5000,
        runtimeMs: 15_000,
        sessionId: "sess-archived",
        spawnedBy: "agent:main:main",
        startedAt: now - 20_000,
        status: "done",
        updatedAt: now,
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const archived = result.sessions.find(
      (session) => session.key === "agent:main:subagent:archived",
    );
    expect(archived?.status).toBe("done");
    expect(archived?.startedAt).toBe(now - 20_000);
    expect(archived?.endedAt).toBe(now - 5000);
    expect(archived?.runtimeMs).toBe(15_000);
  });

  test("maps timeout outcomes to timeout status and clamps negative runtime", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:timeout": {
        sessionId: "sess-timeout",
        spawnedBy: "agent:main:main",
        updatedAt: now,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:timeout",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      endedAt: now - 2000,
      model: "openai/gpt-5.4",
      outcome: { status: "timeout" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-timeout",
      startedAt: now - 1000,
      task: "timeout task",
    });

    const result = listSessionsFromStore({
      cfg,
      opts: {},
      store,
      storePath: "/tmp/sessions.json",
    });

    const timeout = result.sessions.find(
      (session) => session.key === "agent:main:subagent:timeout",
    );
    expect(timeout?.status).toBe("timeout");
    expect(timeout?.runtimeMs).toBe(0);
  });

  test("fails closed when model lookup misses", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", input: ["text", "image"], name: "GPT-5.4", provider: "other" },
        ],
        model: "gpt-5.4",
        provider: "openai",
      }),
    ).resolves.toBe(false);
  });

  test("fails closed when model catalog load throws", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: async () => {
          throw new Error("catalog unavailable");
        },
        model: "gpt-5.4",
        provider: "openai",
      }),
    ).resolves.toBe(false);
  });
});

describe("loadCombinedSessionStoreForGateway includes disk-only agents (#32804)", () => {
  test("ACP agent sessions are visible even when agents.list is configured", async () => {
    await withStateDirEnv("openclaw-acp-vis-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      fs.writeFileSync(
        path.join(mainDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main": { sessionId: "s-main", updatedAt: 100 },
        }),
        "utf8",
      );

      fs.writeFileSync(
        path.join(codexDir, "sessions.json"),
        JSON.stringify({
          "agent:codex:acp-task": { sessionId: "s-codex", updatedAt: 200 },
        }),
        "utf8",
      );

      const cfg = {
        agents: {
          list: [{ default: true, id: "main" }],
        },
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
      } as OpenClawConfig;

      const { store } = loadCombinedSessionStoreForGateway(cfg);
      expect(store["agent:main:main"]).toBeDefined();
      expect(store["agent:codex:acp-task"]).toBeDefined();
    });
  });
});
