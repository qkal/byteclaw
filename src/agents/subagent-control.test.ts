import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as sessions from "../config/sessions.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import {
  __testing,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  killSubagentRunAdmin,
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "./subagent-control.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("sendControlledSubagentMessage", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("rejects runs controlled by another session", async () => {
    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: true,
        callerSessionKey: "agent:main:subagent:leaf",
        controlScope: "children",
        controllerSessionKey: "agent:main:subagent:leaf",
      },
      entry: {
        childSessionKey: "agent:main:subagent:other",
        cleanup: "keep",
        controllerSessionKey: "agent:main:subagent:other-parent",
        createdAt: Date.now() - 5000,
        endedAt: Date.now() - 1000,
        outcome: { status: "ok" },
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-foreign",
        startedAt: Date.now() - 4000,
        task: "foreign run",
      },
      message: "continue",
    });

    expect(result).toEqual({
      error: "Subagents can only control runs spawned from their own session.",
      status: "forbidden",
    });
  });

  it("returns a structured error when the gateway send fails", async () => {
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:owned",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-owned",
      startedAt: Date.now() - 4000,
      task: "continue work",
    });

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent") {
          throw new Error("gateway unavailable");
        }
        return {} as T;
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey: "agent:main:subagent:owned",
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 5000,
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-owned",
        startedAt: Date.now() - 4000,
        task: "continue work",
      },
      message: "continue",
    });

    expect(result).toEqual({
      error: "gateway unavailable",
      runId: expect.any(String),
      status: "error",
    });
  });

  it("does not send to a newer live run when the caller passes a stale run entry", async () => {
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:send-worker",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 4000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-send",
      startedAt: Date.now() - 3000,
      task: "current task",
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey: "agent:main:subagent:send-worker",
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 9000,
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-stale-send",
        startedAt: Date.now() - 8000,
        task: "stale task",
      },
      message: "continue",
    });

    expect(result).toEqual({
      runId: "run-stale-send",
      status: "done",
      text: "stale task is already finished.",
    });
  });

  it("sends follow-up messages to the exact finished current run", async () => {
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:finished-worker",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-finished-send",
      startedAt: Date.now() - 4000,
      task: "finished task",
    });

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "chat.history") {
          return { messages: [] } as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-send" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey: "agent:main:subagent:finished-worker",
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 5000,
        endedAt: Date.now() - 1000,
        outcome: { status: "ok" },
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-finished-send",
        startedAt: Date.now() - 4000,
        task: "finished task",
      },
      message: "continue",
    });

    expect(result).toEqual({
      replyText: undefined,
      runId: "run-followup-send",
      status: "ok",
    });
  });

  it("sends follow-up messages to the newest finished run when stale active rows still exist", async () => {
    const childSessionKey = "agent:main:subagent:finished-stale-worker";
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 9000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-stale-active-send",
      startedAt: Date.now() - 8000,
      task: "stale active task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-finished-send",
      startedAt: Date.now() - 4000,
      task: "finished task",
    });

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "chat.history") {
          return { messages: [] } as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-stale-send" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey,
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 5000,
        endedAt: Date.now() - 1000,
        outcome: { status: "ok" },
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-current-finished-send",
        startedAt: Date.now() - 4000,
        task: "finished task",
      },
      message: "continue",
    });

    expect(result).toEqual({
      replyText: undefined,
      runId: "run-followup-stale-send",
      status: "ok",
    });
  });

  it("does not return the previous assistant reply when no new assistant message appears", async () => {
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:owned-stale-reply",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-owned-stale-reply",
      startedAt: Date.now() - 4000,
      task: "continue work",
    });

    let historyCalls = 0;
    const staleAssistantMessage = {
      content: [{ text: "older reply from a previous run", type: "text" }],
      role: "assistant",
    };

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "chat.history") {
          historyCalls += 1;
          return { messages: [staleAssistantMessage] } as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-stale-reply" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey: "agent:main:subagent:owned-stale-reply",
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 5000,
        endedAt: Date.now() - 1000,
        outcome: { status: "ok" },
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-owned-stale-reply",
        startedAt: Date.now() - 4000,
        task: "continue work",
      },
      message: "continue",
    });

    expect(historyCalls).toBe(2);
    expect(result).toEqual({
      replyText: undefined,
      runId: "run-followup-stale-reply",
      status: "ok",
    });
  });
});

describe("killSubagentRunAdmin", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("kills a subagent by session key without requester ownership checks", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-admin-kill-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            sessionId: "sess-worker",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:other-controller",
      createdAt: Date.now() - 5000,
      requesterDisplayKey: "other-requester",
      requesterSessionKey: "agent:main:other-requester",
      runId: "run-worker",
      startedAt: Date.now() - 4000,
      task: "do the work",
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await killSubagentRunAdmin({
      cfg,
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: true,
      runId: "run-worker",
      sessionKey: childSessionKey,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("returns found=false when the session key is not tracked as a subagent run", async () => {
    const result = await killSubagentRunAdmin({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:subagent:missing",
    });

    expect(result).toEqual({ found: false, killed: false });
  });

  it("does not kill a newest finished run when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:worker-stale-admin";

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:other-controller",
      createdAt: Date.now() - 9000,
      requesterDisplayKey: "other-requester",
      requesterSessionKey: "agent:main:other-requester",
      runId: "run-stale-admin",
      startedAt: Date.now() - 8000,
      task: "stale admin task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:other-controller",
      createdAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "other-requester",
      requesterSessionKey: "agent:main:other-requester",
      runId: "run-current-admin",
      startedAt: Date.now() - 4000,
      task: "current admin task",
    });

    const result = await killSubagentRunAdmin({
      cfg: {} as OpenClawConfig,
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId: "run-current-admin",
      sessionKey: childSessionKey,
    });
  });

  it("still terminates the run when session store persistence fails during kill", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-admin-kill-store-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:worker-store-fail";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            sessionId: "sess-worker-store-fail",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:other-controller",
      createdAt: Date.now() - 5000,
      requesterDisplayKey: "other-requester",
      requesterSessionKey: "agent:main:other-requester",
      runId: "run-worker-store-fail",
      startedAt: Date.now() - 4000,
      task: "do the work",
    });

    const updateSessionStoreSpy = vi
      .spyOn(sessions, "updateSessionStore")
      .mockRejectedValueOnce(new Error("session store unavailable"));

    try {
      const result = await killSubagentRunAdmin({
        cfg: {
          session: { store: storePath },
        } as OpenClawConfig,
        sessionKey: childSessionKey,
      });

      expect(result).toMatchObject({
        found: true,
        killed: true,
        runId: "run-worker-store-fail",
        sessionKey: childSessionKey,
      });
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
    } finally {
      updateSessionStoreSpy.mockRestore();
    }
  });
});

describe("killControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("does not mutate the live session when the caller passes a stale run entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-stale-kill-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:stale-kill-worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 4000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current",
      startedAt: Date.now() - 3000,
      task: "current task",
    });

    const result = await killControlledSubagentRun({
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey,
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 9000,
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-stale",
        startedAt: Date.now() - 8000,
        task: "stale task",
      },
    });

    expect(result).toEqual({
      label: "stale task",
      runId: "run-stale",
      sessionKey: childSessionKey,
      status: "done",
      text: "stale task is already finished.",
    });
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
      string,
      { abortedLastRun?: boolean }
    >;
    expect(persisted[childSessionKey]?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current");
  });

  it("does not kill a stale child row while cascading descendants from an ended current parent", async () => {
    const parentSessionKey = "agent:main:subagent:kill-parent";
    const childSessionKey = `${parentSessionKey}:subagent:child`;
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      childSessionKey: parentSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 8000,
      endedAt: Date.now() - 6000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-parent-current",
      startedAt: Date.now() - 7000,
      task: "current parent task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: parentSessionKey,
      createdAt: Date.now() - 5000,
      requesterDisplayKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      runId: "run-child-stale",
      startedAt: Date.now() - 4000,
      task: "stale child task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: parentSessionKey,
      createdAt: Date.now() - 3000,
      endedAt: Date.now() - 1500,
      outcome: { status: "ok" },
      requesterDisplayKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      runId: "run-child-current",
      startedAt: Date.now() - 2000,
      task: "current child task",
    });
    addSubagentRunForTests({
      childSessionKey: leafSessionKey,
      cleanup: "keep",
      controllerSessionKey: childSessionKey,
      createdAt: Date.now() - 1000,
      requesterDisplayKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      runId: "run-leaf-active",
      startedAt: Date.now() - 900,
      task: "leaf task",
    });

    const result = await killControlledSubagentRun({
      cfg: {} as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey: parentSessionKey,
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 8000,
        endedAt: Date.now() - 6000,
        outcome: { status: "ok" },
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-parent-current",
        startedAt: Date.now() - 7000,
        task: "current parent task",
      },
    });

    expect(result).toEqual({
      cascadeKilled: 1,
      cascadeLabels: ["leaf task"],
      label: "current parent task",
      runId: "run-parent-current",
      sessionKey: parentSessionKey,
      status: "ok",
      text: "killed 1 descendant of current parent task.",
    });
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("does not cascade through a child session that moved to a newer parent", async () => {
    const oldParentSessionKey = "agent:main:subagent:old-parent";
    const newParentSessionKey = "agent:main:subagent:new-parent";
    const childSessionKey = "agent:main:subagent:shared-child";
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      childSessionKey: oldParentSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 8000,
      endedAt: Date.now() - 6000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-old-parent-current",
      startedAt: Date.now() - 7000,
      task: "old parent task",
    });
    addSubagentRunForTests({
      childSessionKey: newParentSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-new-parent-current",
      startedAt: Date.now() - 4000,
      task: "new parent task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: oldParentSessionKey,
      createdAt: Date.now() - 4000,
      endedAt: Date.now() - 3000,
      outcome: { status: "ok" },
      requesterDisplayKey: oldParentSessionKey,
      requesterSessionKey: oldParentSessionKey,
      runId: "run-child-stale-old-parent",
      startedAt: Date.now() - 3500,
      task: "stale shared child task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: newParentSessionKey,
      createdAt: Date.now() - 2000,
      requesterDisplayKey: newParentSessionKey,
      requesterSessionKey: newParentSessionKey,
      runId: "run-child-current-new-parent",
      startedAt: Date.now() - 1500,
      task: "current shared child task",
    });
    addSubagentRunForTests({
      childSessionKey: leafSessionKey,
      cleanup: "keep",
      controllerSessionKey: childSessionKey,
      createdAt: Date.now() - 1000,
      requesterDisplayKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      runId: "run-leaf-active",
      startedAt: Date.now() - 900,
      task: "leaf task",
    });

    const result = await killControlledSubagentRun({
      cfg: {} as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey: oldParentSessionKey,
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 8000,
        endedAt: Date.now() - 6000,
        outcome: { status: "ok" },
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-old-parent-current",
        startedAt: Date.now() - 7000,
        task: "old parent task",
      },
    });

    expect(result).toEqual({
      label: "old parent task",
      runId: "run-old-parent-current",
      sessionKey: oldParentSessionKey,
      status: "done",
      text: "old parent task is already finished.",
    });
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.endedAt).toBeUndefined();
  });
});

describe("killAllControlledSubagentRuns", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("ignores stale run snapshots in bulk kill requests", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-stale-kill-all-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:stale-kill-all-worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 4000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-bulk",
      startedAt: Date.now() - 3000,
      task: "current bulk task",
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      runs: [
        {
          childSessionKey,
          cleanup: "keep",
          controllerSessionKey: "agent:main:main",
          createdAt: Date.now() - 9000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-stale-bulk",
          startedAt: Date.now() - 8000,
          task: "stale bulk task",
        },
      ],
    });

    expect(result).toEqual({
      killed: 0,
      labels: [],
      status: "ok",
    });
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
      string,
      { abortedLastRun?: boolean }
    >;
    expect(persisted[childSessionKey]?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current-bulk");
  });

  it("does not let a stale bulk entry suppress the current live entry for the same child key", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-subagent-stale-kill-all-shadow-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 4000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-shadow",
      startedAt: Date.now() - 3000,
      task: "current shadow task",
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      runs: [
        {
          childSessionKey,
          cleanup: "keep",
          controllerSessionKey: "agent:main:main",
          createdAt: Date.now() - 9000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-stale-shadow",
          startedAt: Date.now() - 8000,
          task: "stale shadow task",
        },
        {
          childSessionKey,
          cleanup: "keep",
          controllerSessionKey: "agent:main:main",
          createdAt: Date.now() - 4000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-current-shadow",
          startedAt: Date.now() - 3000,
          task: "current shadow task",
        },
      ],
    });

    expect(result).toEqual({
      killed: 1,
      labels: ["current shadow task"],
      status: "ok",
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("does not kill a newest finished bulk target when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:stale-bulk-finished-worker";

    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 9000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-stale-bulk-finished",
      startedAt: Date.now() - 8000,
      task: "stale bulk finished task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-bulk-finished",
      startedAt: Date.now() - 4000,
      task: "current bulk finished task",
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {} as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      runs: [
        {
          childSessionKey,
          cleanup: "keep",
          controllerSessionKey: "agent:main:main",
          createdAt: Date.now() - 5000,
          endedAt: Date.now() - 1000,
          outcome: { status: "ok" },
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-current-bulk-finished",
          startedAt: Date.now() - 4000,
          task: "current bulk finished task",
        },
      ],
    });

    expect(result).toEqual({
      killed: 0,
      labels: [],
      status: "ok",
    });
  });

  it("cascades through descendants for an ended current bulk target even when a stale older row is still active", async () => {
    const parentSessionKey = "agent:main:subagent:stale-bulk-desc-parent";
    const childSessionKey = `${parentSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      childSessionKey: parentSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 9000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-stale-bulk-desc-parent",
      startedAt: Date.now() - 8000,
      task: "stale bulk parent task",
    });
    addSubagentRunForTests({
      childSessionKey: parentSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-bulk-desc-parent",
      startedAt: Date.now() - 4000,
      task: "current bulk parent task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: parentSessionKey,
      createdAt: Date.now() - 3000,
      requesterDisplayKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      runId: "run-active-bulk-desc-child",
      startedAt: Date.now() - 2000,
      task: "active bulk child task",
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {} as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      runs: [
        {
          childSessionKey: parentSessionKey,
          cleanup: "keep",
          controllerSessionKey: "agent:main:main",
          createdAt: Date.now() - 5000,
          endedAt: Date.now() - 1000,
          outcome: { status: "ok" },
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-current-bulk-desc-parent",
          startedAt: Date.now() - 4000,
          task: "current bulk parent task",
        },
      ],
    });

    expect(result).toEqual({
      killed: 1,
      labels: ["active bulk child task"],
      status: "ok",
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });
});

describe("steerControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("returns an error and clears the restart marker when run remap fails", async () => {
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:steer-worker",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-steer-old",
      startedAt: Date.now() - 4000,
      task: "initial task",
    });

    const replaceSpy = vi
      .spyOn(await import("./subagent-registry.js"), "replaceSubagentRunAfterSteer")
      .mockReturnValue(false);

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          return { runId: "run-steer-new" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    try {
      const result = await steerControlledSubagentRun({
        cfg: {} as OpenClawConfig,
        controller: {
          callerIsSubagent: false,
          callerSessionKey: "agent:main:main",
          controlScope: "children",
          controllerSessionKey: "agent:main:main",
        },
        entry: {
          childSessionKey: "agent:main:subagent:steer-worker",
          cleanup: "keep",
          controllerSessionKey: "agent:main:main",
          createdAt: Date.now() - 5000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-steer-old",
          startedAt: Date.now() - 4000,
          task: "initial task",
        },
        message: "updated direction",
      });

      expect(result).toEqual({
        error: "failed to replace steered subagent run",
        runId: "run-steer-new",
        sessionId: undefined,
        sessionKey: "agent:main:subagent:steer-worker",
        status: "error",
      });
      expect(getSubagentRunByChildSessionKey("agent:main:subagent:steer-worker")).toMatchObject({
        runId: "run-steer-old",
        suppressAnnounceReason: undefined,
      });
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it("rejects steering runs that are no longer tracked in the registry", async () => {
    __testing.setDepsForTest({
      callGateway: async () => {
        throw new Error("gateway should not be called");
      },
    });

    const result = await steerControlledSubagentRun({
      cfg: {} as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey: "agent:main:subagent:stale-worker",
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 5000,
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-stale",
        startedAt: Date.now() - 4000,
        task: "stale task",
      },
      message: "updated direction",
    });

    expect(result).toEqual({
      runId: "run-stale",
      sessionKey: "agent:main:subagent:stale-worker",
      status: "done",
      text: "stale task is already finished.",
    });
  });

  it("steers an ended current run that is still waiting on active descendants even when stale older rows exist", async () => {
    const childSessionKey = "agent:main:subagent:stale-steer-worker";
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 9000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-stale-active-steer",
      startedAt: Date.now() - 8000,
      task: "stale active steer task",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-current-ended-steer",
      startedAt: Date.now() - 4000,
      task: "current ended steer task",
    });
    addSubagentRunForTests({
      childSessionKey: `${childSessionKey}:subagent:leaf`,
      cleanup: "keep",
      controllerSessionKey: childSessionKey,
      createdAt: Date.now() - 500,
      requesterDisplayKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      runId: "run-descendant-active-steer",
      startedAt: Date.now() - 500,
      task: "leaf task",
    });

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-steer" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await steerControlledSubagentRun({
      cfg: {} as OpenClawConfig,
      controller: {
        callerIsSubagent: false,
        callerSessionKey: "agent:main:main",
        controlScope: "children",
        controllerSessionKey: "agent:main:main",
      },
      entry: {
        childSessionKey,
        cleanup: "keep",
        controllerSessionKey: "agent:main:main",
        createdAt: Date.now() - 5000,
        endedAt: Date.now() - 1000,
        outcome: { status: "ok" },
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-current-ended-steer",
        startedAt: Date.now() - 4000,
        task: "current ended steer task",
      },
      message: "updated direction",
    });

    expect(result).toEqual({
      label: "current ended steer task",
      mode: "restart",
      runId: "run-followup-steer",
      sessionId: undefined,
      sessionKey: childSessionKey,
      status: "accepted",
      text: "steered current ended steer task.",
    });
  });
});
