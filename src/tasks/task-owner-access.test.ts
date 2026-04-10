import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  findLatestTaskForRelatedSessionKeyForOwner,
  findTaskByRunIdForOwner,
  getTaskByIdForOwner,
  resolveTaskForLookupTokenForOwner,
} from "./task-owner-access.js";
import { createTaskRecord, resetTaskRegistryForTests } from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  if (ORIGINAL_STATE_DIR == null) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

async function withTaskRegistryTempDir<T>(run: () => Promise<T> | T): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-owner-access-" }, async (root) => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests({ persist: false });
    try {
      return await run();
    } finally {
      resetTaskRegistryForTests({ persist: false });
      if (previousStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
}

describe("task owner access", () => {
  it("returns owner-scoped tasks for owner and child-session lookups", async () => {
    await withTaskRegistryTempDir(() => {
      const task = createTaskRecord({
        childSessionKey: "agent:main:subagent:child-1",
        ownerKey: "agent:main:main",
        runId: "owner-visible-run",
        runtime: "subagent",
        scopeKind: "session",
        status: "running",
        task: "Owner visible task",
      });

      expect(
        findLatestTaskForRelatedSessionKeyForOwner({
          callerOwnerKey: "agent:main:main",
          relatedSessionKey: "agent:main:subagent:child-1",
        })?.taskId,
      ).toBe(task.taskId);
      expect(
        findTaskByRunIdForOwner({
          callerOwnerKey: "agent:main:main",
          runId: "owner-visible-run",
        })?.taskId,
      ).toBe(task.taskId);
    });
  });

  it("denies cross-owner task reads", async () => {
    await withTaskRegistryTempDir(() => {
      const task = createTaskRecord({
        childSessionKey: "agent:main:acp:child-1",
        ownerKey: "agent:main:main",
        runId: "owner-hidden-run",
        runtime: "acp",
        scopeKind: "session",
        status: "queued",
        task: "Hidden task",
      });

      expect(
        getTaskByIdForOwner({
          callerOwnerKey: "agent:main:subagent:other-parent",
          taskId: task.taskId,
        }),
      ).toBeUndefined();
      expect(
        findTaskByRunIdForOwner({
          callerOwnerKey: "agent:main:subagent:other-parent",
          runId: "owner-hidden-run",
        }),
      ).toBeUndefined();
      expect(
        resolveTaskForLookupTokenForOwner({
          callerOwnerKey: "agent:main:subagent:other-parent",
          token: "agent:main:acp:child-1",
        }),
      ).toBeUndefined();
    });
  });

  it("requires an exact owner-key match", async () => {
    await withTaskRegistryTempDir(() => {
      const task = createTaskRecord({
        ownerKey: "agent:main:MixedCase",
        runId: "case-sensitive-owner-run",
        runtime: "acp",
        scopeKind: "session",
        status: "queued",
        task: "Case-sensitive owner",
      });

      expect(
        getTaskByIdForOwner({
          callerOwnerKey: "agent:main:mixedcase",
          taskId: task.taskId,
        }),
      ).toBeUndefined();
    });
  });

  it("does not expose system-owned tasks through owner-scoped readers", async () => {
    await withTaskRegistryTempDir(() => {
      const task = createTaskRecord({
        childSessionKey: "agent:main:cron:nightly",
        deliveryStatus: "not_applicable",
        ownerKey: "system:cron:nightly",
        requesterSessionKey: "system:cron:nightly",
        runId: "system-task-run",
        runtime: "cron",
        scopeKind: "system",
        status: "running",
        task: "Nightly cron",
      });

      expect(
        getTaskByIdForOwner({
          callerOwnerKey: "agent:main:main",
          taskId: task.taskId,
        }),
      ).toBeUndefined();
      expect(
        resolveTaskForLookupTokenForOwner({
          callerOwnerKey: "agent:main:main",
          token: "system-task-run",
        }),
      ).toBeUndefined();
    });
  });
});
