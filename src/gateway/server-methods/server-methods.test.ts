import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.js";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../../infra/system-run-approval-binding.js";
import { resetLogger, setLoggerOverride } from "../../logging.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { validateExecApprovalRequestParams } from "../protocol/index.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { sanitizeChatSendMessageInput } from "./chat.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import { logsHandlers } from "./logs.js";

vi.mock("../../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("waitForAgentJob", () => {
  async function runLifecycleScenario(params: {
    runIdPrefix: string;
    startedAt: number;
    endedAt: number;
    aborted?: boolean;
  }) {
    const runId = `${params.runIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1000 });

    emitAgentEvent({
      data: { phase: "start", startedAt: params.startedAt },
      runId,
      stream: "lifecycle",
    });
    emitAgentEvent({
      data: { aborted: params.aborted, endedAt: params.endedAt, phase: "end" },
      runId,
      stream: "lifecycle",
    });

    return waitPromise;
  }

  it("maps lifecycle end events with aborted=true to timeout", async () => {
    const snapshot = await runLifecycleScenario({
      aborted: true,
      endedAt: 200,
      runIdPrefix: "run-timeout",
      startedAt: 100,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("timeout");
    expect(snapshot?.startedAt).toBe(100);
    expect(snapshot?.endedAt).toBe(200);
  });

  it("keeps non-aborted lifecycle end events as ok", async () => {
    const snapshot = await runLifecycleScenario({
      endedAt: 400,
      runIdPrefix: "run-ok",
      startedAt: 300,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.startedAt).toBe(300);
    expect(snapshot?.endedAt).toBe(400);
  });

  it("can ignore cached snapshots and wait for fresh lifecycle events", async () => {
    const runId = `run-ignore-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    emitAgentEvent({
      data: { endedAt: 110, phase: "end", startedAt: 100 },
      runId,
      stream: "lifecycle",
    });

    const cached = await waitForAgentJob({ runId, timeoutMs: 1000 });
    expect(cached?.status).toBe("ok");
    expect(cached?.startedAt).toBe(100);
    expect(cached?.endedAt).toBe(110);

    const freshWait = waitForAgentJob({
      ignoreCachedSnapshot: true,
      runId,
      timeoutMs: 1000,
    });
    queueMicrotask(() => {
      emitAgentEvent({
        data: { phase: "start", startedAt: 200 },
        runId,
        stream: "lifecycle",
      });
      emitAgentEvent({
        data: { endedAt: 210, phase: "end", startedAt: 200 },
        runId,
        stream: "lifecycle",
      });
    });

    const fresh = await freshWait;
    expect(fresh?.status).toBe("ok");
    expect(fresh?.startedAt).toBe(200);
    expect(fresh?.endedAt).toBe(210);
  });
});

describe("injectTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-29T01:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepends a compact timestamp matching formatZonedTimestamp", () => {
    const result = injectTimestamp("Is it the weekend?", {
      timezone: "America/New_York",
    });

    expect(result).toMatch(/^\[Wed 2026-01-28 20:30 EST\] Is it the weekend\?$/);
  });

  it("uses channel envelope format with DOW prefix", () => {
    const now = new Date();
    const expected = formatZonedTimestamp(now, { timeZone: "America/New_York" });

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toBe(`[Wed ${expected}] hello`);
  });

  it("always uses 24-hour format", () => {
    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toContain("20:30");
    expect(result).not.toContain("PM");
    expect(result).not.toContain("AM");
  });

  it("uses the configured timezone", () => {
    const result = injectTimestamp("hello", { timezone: "America/Chicago" });

    expect(result).toMatch(/^\[Wed 2026-01-28 19:30 CST\]/);
  });

  it("defaults to UTC when no timezone specified", () => {
    const result = injectTimestamp("hello", {});

    expect(result).toMatch(/^\[Thu 2026-01-29 01:30/);
  });

  it("returns empty/whitespace messages unchanged", () => {
    expect(injectTimestamp("", { timezone: "UTC" })).toBe("");
    expect(injectTimestamp("   ", { timezone: "UTC" })).toBe("   ");
  });

  it("does NOT double-stamp messages with channel envelope timestamps", () => {
    const enveloped = "[Discord user1 2026-01-28 20:30 EST] hello there";
    const result = injectTimestamp(enveloped, { timezone: "America/New_York" });

    expect(result).toBe(enveloped);
  });

  it("does NOT double-stamp messages already injected by us", () => {
    const alreadyStamped = "[Wed 2026-01-28 20:30 EST] hello there";
    const result = injectTimestamp(alreadyStamped, { timezone: "America/New_York" });

    expect(result).toBe(alreadyStamped);
  });

  it("does NOT double-stamp messages with cron-injected timestamps", () => {
    const cronMessage =
      "[cron:abc123 my-job] do the thing\nCurrent time: Wednesday, January 28th, 2026 — 8:30 PM (America/New_York)";
    const result = injectTimestamp(cronMessage, { timezone: "America/New_York" });

    expect(result).toBe(cronMessage);
  });

  it("handles midnight correctly", () => {
    vi.setSystemTime(new Date("2026-02-01T05:00:00.000Z"));

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toMatch(/^\[Sun 2026-02-01 00:00 EST\]/);
  });

  it("handles date boundaries (just before midnight)", () => {
    vi.setSystemTime(new Date("2026-02-01T04:59:00.000Z"));

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toMatch(/^\[Sat 2026-01-31 23:59 EST\]/);
  });

  it("handles DST correctly (same UTC hour, different local time)", () => {
    vi.setSystemTime(new Date("2026-01-15T05:00:00.000Z"));
    const winter = injectTimestamp("winter", { timezone: "America/New_York" });
    expect(winter).toMatch(/^\[Thu 2026-01-15 00:00 EST\]/);

    vi.setSystemTime(new Date("2026-07-15T04:00:00.000Z"));
    const summer = injectTimestamp("summer", { timezone: "America/New_York" });
    expect(summer).toMatch(/^\[Wed 2026-07-15 00:00 EDT\]/);
  });

  it("accepts a custom now date", () => {
    const customDate = new Date("2025-07-04T16:00:00.000Z");

    const result = injectTimestamp("fireworks?", {
      now: customDate,
      timezone: "America/New_York",
    });

    expect(result).toMatch(/^\[Fri 2025-07-04 12:00 EDT\]/);
  });
});

describe("timestampOptsFromConfig", () => {
  it.each([
    {
      cfg: { agents: { defaults: { userTimezone: "America/Chicago" } } } as any,
      expected: "America/Chicago",
      name: "extracts timezone from config",
    },
    {
      cfg: {} as any,
      expected: Intl.DateTimeFormat().resolvedOptions().timeZone,
      name: "falls back gracefully with empty config",
    },
  ])("$name", ({ cfg, expected }) => {
    expect(timestampOptsFromConfig(cfg).timezone).toBe(expected);
  });
});

describe("normalizeRpcAttachmentsToChatAttachments", () => {
  it.each([
    {
      attachments: [{ content: "Zm9v", fileName: "a.png", mimeType: "image/png", type: "file" }],
      expected: [{ content: "Zm9v", fileName: "a.png", mimeType: "image/png", type: "file" }],
      name: "passes through string content",
    },
    {
      attachments: [{ content: new TextEncoder().encode("foo") }],
      expected: [{ content: "Zm9v", fileName: undefined, mimeType: undefined, type: undefined }],
      name: "converts Uint8Array content to base64",
    },
    {
      attachments: [{ content: new TextEncoder().encode("bar").buffer }],
      expected: [{ content: "YmFy", fileName: undefined, mimeType: undefined, type: undefined }],
      name: "converts ArrayBuffer content to base64",
    },
    {
      attachments: [{ content: undefined }, { mimeType: "image/png" }],
      expected: [],
      name: "drops attachments without usable content",
    },
  ])("$name", ({ attachments, expected }) => {
    expect(normalizeRpcAttachmentsToChatAttachments(attachments)).toEqual(expected);
  });

  it("accepts dashboard image attachments with nested base64 source", () => {
    const res = normalizeRpcAttachmentsToChatAttachments([
      {
        source: {
          data: "Zm9v",
          media_type: "image/png",
          type: "base64",
        },
        type: "image",
      },
    ]);
    expect(res).toEqual([
      {
        content: "Zm9v",
        fileName: undefined,
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });
});

describe("sanitizeChatSendMessageInput", () => {
  it.each([
    {
      expected: { error: "message must not contain null bytes", ok: false as const },
      input: "before\u0000after",
      name: "rejects null bytes",
    },
    {
      expected: { message: "ab\tc\nd\ref", ok: true as const },
      input: "a\u0001b\tc\nd\re\u0007f\u007f",
      name: "strips unsafe control characters while preserving tab/newline/carriage return",
    },
    {
      expected: { message: "Café", ok: true as const },
      input: "Cafe\u0301",
      name: "normalizes unicode to NFC",
    },
  ])("$name", ({ input, expected }) => {
    expect(sanitizeChatSendMessageInput(input)).toEqual(expected);
  });
});

describe("gateway chat transcript writes (guardrail)", () => {
  it("routes transcript writes through helper and SessionManager parentId append", () => {
    const chatTs = fileURLToPath(new URL("chat.ts", import.meta.url));
    const chatSrc = fs.readFileSync(chatTs, "utf8");
    const helperTs = fileURLToPath(new URL("chat-transcript-inject.ts", import.meta.url));
    const helperSrc = fs.readFileSync(helperTs, "utf8");

    expect(chatSrc.includes("fs.appendFileSync(transcriptPath")).toBe(false);
    expect(chatSrc).toContain("appendInjectedAssistantMessageToTranscript(");

    expect(helperSrc.includes("fs.appendFileSync(params.transcriptPath")).toBe(false);
    expect(helperSrc).toContain("SessionManager.open(params.transcriptPath)");
    expect(helperSrc).toContain("appendMessage(messageBody)");
  });
});

describe("exec approval handlers", () => {
  const execApprovalNoop = () => false;
  type ExecApprovalHandlers = ReturnType<typeof createExecApprovalHandlers>;
  type ExecApprovalGetArgs = Parameters<ExecApprovalHandlers["exec.approval.get"]>[0];
  type ExecApprovalRequestArgs = Parameters<ExecApprovalHandlers["exec.approval.request"]>[0];
  type ExecApprovalResolveArgs = Parameters<ExecApprovalHandlers["exec.approval.resolve"]>[0];

  const defaultExecApprovalRequestParams = {
    command: "echo ok",
    commandArgv: ["echo", "ok"],
    cwd: "/tmp",
    host: "node",
    nodeId: "node-1",
    systemRunPlan: {
      agentId: "main",
      argv: ["/usr/bin/echo", "ok"],
      commandText: "/usr/bin/echo ok",
      cwd: "/tmp",
      sessionKey: "agent:main:main",
    },
    timeoutMs: 2000,
  } as const;

  function toExecApprovalRequestContext(context: {
    broadcast: (event: string, payload: unknown) => void;
    hasExecApprovalClients?: () => boolean;
  }): ExecApprovalRequestArgs["context"] {
    return context as unknown as ExecApprovalRequestArgs["context"];
  }

  function toExecApprovalResolveContext(context: {
    broadcast: (event: string, payload: unknown) => void;
  }): ExecApprovalResolveArgs["context"] {
    return context as unknown as ExecApprovalResolveArgs["context"];
  }

  async function getExecApproval(params: {
    handlers: ExecApprovalHandlers;
    id: string;
    respond: ReturnType<typeof vi.fn>;
  }) {
    return params.handlers["exec.approval.get"]({
      client: null,
      context: {} as ExecApprovalGetArgs["context"],
      isWebchatConnect: execApprovalNoop,
      params: { id: params.id } as ExecApprovalGetArgs["params"],
      req: { id: "req-get", method: "exec.approval.get", type: "req" },
      respond: params.respond as unknown as ExecApprovalGetArgs["respond"],
    });
  }

  async function listExecApprovals(params: {
    handlers: ExecApprovalHandlers;
    respond: ReturnType<typeof vi.fn>;
  }) {
    return params.handlers["exec.approval.list"]({
      client: null,
      context: {} as never,
      isWebchatConnect: execApprovalNoop,
      params: {} as never,
      req: { id: "req-list", method: "exec.approval.list", type: "req" },
      respond: params.respond as never,
    });
  }

  async function requestExecApproval(params: {
    handlers: ExecApprovalHandlers;
    respond: ReturnType<typeof vi.fn>;
    context: { broadcast: (event: string, payload: unknown) => void };
    params?: Record<string, unknown>;
  }) {
    const requestParams = {
      ...defaultExecApprovalRequestParams,
      ...params.params,
    } as unknown as ExecApprovalRequestArgs["params"];
    const hasExplicitPlan = Boolean(params.params) && Object.hasOwn(params.params, "systemRunPlan");
    if (
      !hasExplicitPlan &&
      (requestParams as { host?: string }).host === "node" &&
      Array.isArray((requestParams as { commandArgv?: unknown }).commandArgv)
    ) {
      const commandArgv = (requestParams as { commandArgv: unknown[] }).commandArgv.map((entry) =>
        String(entry),
      );
      const cwdValue =
        typeof (requestParams as { cwd?: unknown }).cwd === "string"
          ? ((requestParams as { cwd: string }).cwd ?? null)
          : null;
      const commandText =
        typeof (requestParams as { command?: unknown }).command === "string"
          ? ((requestParams as { command: string }).command ?? null)
          : null;
      requestParams.systemRunPlan = {
        agentId:
          typeof (requestParams as { agentId?: unknown }).agentId === "string"
            ? ((requestParams as { agentId: string }).agentId ?? null)
            : null,
        argv: commandArgv,
        commandText: commandText ?? commandArgv.join(" "),
        cwd: cwdValue,
        sessionKey:
          typeof (requestParams as { sessionKey?: unknown }).sessionKey === "string"
            ? ((requestParams as { sessionKey: string }).sessionKey ?? null)
            : null,
      };
    }
    return params.handlers["exec.approval.request"]({
      client: null,
      context: toExecApprovalRequestContext({
        hasExecApprovalClients: () => true,
        ...params.context,
      }),
      isWebchatConnect: execApprovalNoop,
      params: requestParams,
      req: { id: "req-1", method: "exec.approval.request", type: "req" },
      respond: params.respond as unknown as ExecApprovalRequestArgs["respond"],
    });
  }

  async function resolveExecApproval(params: {
    handlers: ExecApprovalHandlers;
    id: string;
    decision?: "allow-once" | "allow-always" | "deny";
    respond: ReturnType<typeof vi.fn>;
    context: { broadcast: (event: string, payload: unknown) => void };
  }) {
    return params.handlers["exec.approval.resolve"]({
      client: null,
      context: toExecApprovalResolveContext(params.context),
      isWebchatConnect: execApprovalNoop,
      params: {
        decision: params.decision ?? "allow-once",
        id: params.id,
      } as ExecApprovalResolveArgs["params"],
      req: { id: "req-2", method: "exec.approval.resolve", type: "req" },
      respond: params.respond as unknown as ExecApprovalResolveArgs["respond"],
    });
  }

  function createExecApprovalFixture() {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const broadcasts: { event: string; payload: unknown }[] = [];
    const respond = vi.fn();
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
      hasExecApprovalClients: () => true,
    };
    return { broadcasts, context, handlers, respond };
  }

  function createForwardingExecApprovalFixture(opts?: {
    iosPushDelivery?: {
      handleRequested: ReturnType<typeof vi.fn>;
      handleResolved: ReturnType<typeof vi.fn>;
      handleExpired: ReturnType<typeof vi.fn>;
    };
  }) {
    const manager = new ExecApprovalManager();
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved: vi.fn(async () => {}),
      stop: vi.fn(),
    };
    const handlers = createExecApprovalHandlers(manager, {
      forwarder,
      iosPushDelivery: opts?.iosPushDelivery as never,
    });
    const respond = vi.fn();
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
      hasExecApprovalClients: () => false,
    };
    return {
      context,
      forwarder,
      handlers,
      iosPushDelivery: opts?.iosPushDelivery,
      manager,
      respond,
    };
  }

  async function drainApprovalRequestTicks() {
    for (let idx = 0; idx < 20; idx += 1) {
      await Promise.resolve();
    }
  }

  describe("ExecApprovalRequestParams validation", () => {
    const baseParams = {
      command: "echo hi",
      cwd: "/tmp",
      host: "node",
      nodeId: "node-1",
    };

    it.each([
      { extra: {}, label: "omitted" },
      { extra: { resolvedPath: "/usr/bin/echo" }, label: "string" },
      { extra: { resolvedPath: undefined }, label: "undefined" },
      { extra: { resolvedPath: null }, label: "null" },
    ])("accepts request with resolvedPath $label", ({ extra }) => {
      const params = { ...baseParams, ...extra };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });
  });

  it("rejects host=node approval requests without nodeId", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        nodeId: undefined,
      },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "nodeId is required for host=node",
      }),
    );
  });

  it("rejects host=node approval requests without systemRunPlan", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        systemRunPlan: undefined,
      },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "systemRunPlan is required for host=node",
      }),
    );
  });

  it("returns pending approval details for exec.approval.get", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: {
        command: "echo ok",
        commandArgv: ["echo", "ok"],
        host: "gateway",
        nodeId: undefined,
        systemRunPlan: undefined,
        twoPhase: true,
      },
      respond,
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    const getRespond = vi.fn();
    await getExecApproval({ handlers, id, respond: getRespond });

    expect(getRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: null,
        allowedDecisions: expect.arrayContaining(["allow-once", "allow-always", "deny"]),
        commandText: "echo ok",
        host: "gateway",
        id,
        nodeId: null,
      }),
      undefined,
    );

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      context,
      handlers,
      id,
      respond: resolveRespond,
    });
    await requestPromise;
  });

  it("lists pending exec approvals", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();
    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: {
        host: "gateway",
        id: "approval-list-1",
        nodeId: undefined,
        systemRunPlan: undefined,
        twoPhase: true,
      },
      respond,
    });

    const listRespond = vi.fn();
    await listExecApprovals({ handlers, respond: listRespond });

    expect(listRespond).toHaveBeenCalledWith(
      true,
      expect.arrayContaining([
        expect.objectContaining({
          id: "approval-list-1",
          request: expect.objectContaining({
            command: "echo ok",
          }),
        }),
      ]),
      undefined,
    );

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      context,
      handlers,
      id: "approval-list-1",
      respond: resolveRespond,
    });
    await requestPromise;
  });

  it("returns not found for stale exec.approval.get ids", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", nodeId: undefined, systemRunPlan: undefined, twoPhase: true },
      respond,
    });
    const acceptedId = respond.mock.calls.find((call) => call[1]?.status === "accepted")?.[1]?.id;
    expect(typeof acceptedId).toBe("string");

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      context,
      handlers,
      id: acceptedId as string,
      respond: resolveRespond,
    });
    await requestPromise;

    const getRespond = vi.fn();
    await getExecApproval({ handlers, id: acceptedId as string, respond: getRespond });
    expect(getRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown or expired approval id",
      }),
    );
  });

  it("broadcasts request + resolve", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: { twoPhase: true },
      respond,
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id, status: "accepted" }),
      undefined,
    );

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      context,
      handlers,
      id,
      respond: resolveRespond,
    });

    await requestPromise;

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once", id }),
      undefined,
    );
    expect(broadcasts.some((entry) => entry.event === "exec.approval.resolved")).toBe(true);
  });

  it("rejects allow-always when the request ask mode is always", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: { ask: "always", twoPhase: true },
      respond,
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      context,
      decision: "allow-always",
      handlers,
      id,
      respond: resolveRespond,
    });

    expect(resolveRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message:
          "allow-always is unavailable because the effective policy requires approval every time",
      }),
    );

    const denyRespond = vi.fn();
    await resolveExecApproval({
      context,
      decision: "deny",
      handlers,
      id,
      respond: denyRespond,
    });

    await requestPromise;
    expect(denyRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("does not reuse a resolved exact id as a prefix for another pending approval", () => {
    const manager = new ExecApprovalManager();
    const resolvedRecord = manager.create({ command: "echo old", host: "gateway" }, 2000, "abc");
    void manager.register(resolvedRecord, 2000);
    expect(manager.resolve("abc", "allow-once")).toBe(true);

    const pendingRecord = manager.create({ command: "echo new", host: "gateway" }, 2000, "abcdef");
    void manager.register(pendingRecord, 2000);

    expect(manager.lookupPendingId("abc")).toEqual({ kind: "none" });
    expect(manager.lookupPendingId("abcdef")).toEqual({ id: "abcdef", kind: "exact" });
  });

  it("stores versioned system.run binding and sorted env keys on approval request", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        commandArgv: ["echo", "ok"],
        env: {
          A_VAR: "a",
          Z_VAR: "z",
        },
        timeoutMs: 10,
      },
      respond,
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["envKeys"]).toEqual(["A_VAR", "Z_VAR"]);
    expect(request["systemRunBinding"]).toEqual(
      buildSystemRunApprovalBinding({
        argv: ["echo", "ok"],
        cwd: "/tmp",
        env: { A_VAR: "a", Z_VAR: "z" },
      }).binding,
    );
  });

  it("includes Windows-compatible env keys in approval env bindings", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        command: "cmd.exe /c echo ok",
        commandArgv: ["cmd.exe", "/c", "echo", "ok"],
        env: {
          "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
        },
        timeoutMs: 10,
      },
      respond,
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    const envBinding = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
    });
    expect(request["envKeys"]).toEqual(envBinding.envKeys);
    expect(request["systemRunBinding"]).toEqual(
      buildSystemRunApprovalBinding({
        argv: ["cmd.exe", "/c", "echo", "ok"],
        cwd: "/tmp",
        env: { "ProgramFiles(x86)": String.raw`C:\Program Files (x86)` },
      }).binding,
    );
  });

  it("stores sorted env keys for gateway approvals without node-only binding", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        env: {
          A_VAR: "a",
          Z_VAR: "z",
        },
        host: "gateway",
        nodeId: undefined,
        systemRunPlan: undefined,
      },
      respond,
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["envKeys"]).toEqual(
      buildSystemRunApprovalEnvBinding({ A_VAR: "a", Z_VAR: "z" }).envKeys,
    );
    expect(request["systemRunBinding"]).toBeNull();
  });

  it("prefers systemRunPlan canonical command/cwd when present", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        command: "echo stale",
        commandArgv: ["echo", "stale"],
        cwd: "/tmp/link/sub",
        systemRunPlan: {
          agentId: "main",
          argv: ["/usr/bin/echo", "ok"],
          commandPreview: "echo ok",
          commandText: "/usr/bin/echo ok",
          cwd: "/real/cwd",
          sessionKey: "agent:main:main",
        },
        timeoutMs: 10,
      },
      respond,
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["command"]).toBe("/usr/bin/echo ok");
    expect(request["commandPreview"]).toBeUndefined();
    expect(request["commandArgv"]).toBeUndefined();
    expect(request["cwd"]).toBe("/real/cwd");
    expect(request["agentId"]).toBe("main");
    expect(request["sessionKey"]).toBe("agent:main:main");
    expect(request["systemRunPlan"]).toEqual({
      agentId: "main",
      argv: ["/usr/bin/echo", "ok"],
      commandPreview: "echo ok",
      commandText: "/usr/bin/echo ok",
      cwd: "/real/cwd",
      sessionKey: "agent:main:main",
    });
  });

  it("derives a command preview from the fallback command for older node plans", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        command: "jq --version",
        commandArgv: ["./env", "sh", "-c", "jq --version"],
        systemRunPlan: {
          agentId: "main",
          argv: ["./env", "sh", "-c", "jq --version"],
          commandText: './env sh -c "jq --version"',
          cwd: "/real/cwd",
          sessionKey: "agent:main:main",
        },
        timeoutMs: 10,
      },
      respond,
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["command"]).toBe('./env sh -c "jq --version"');
    expect(request["commandPreview"]).toBeUndefined();
    expect((request["systemRunPlan"] as { commandPreview?: string }).commandPreview).toBe(
      "jq --version",
    );
  });

  it("sanitizes invisible Unicode format chars in approval display text without changing node bindings", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      context,
      handlers,
      params: {
        command: "bash safe\u200B.sh",
        commandArgv: ["bash", "safe\u200B.sh"],
        systemRunPlan: {
          agentId: "main",
          argv: ["bash", "safe\u200B.sh"],
          commandText: "bash safe\u200B.sh",
          cwd: "/real/cwd",
          sessionKey: "agent:main:main",
        },
        timeoutMs: 10,
      },
      respond,
    });
    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const request = (requested?.payload as { request?: Record<string, unknown> })?.request ?? {};
    expect(request["command"]).toBe(String.raw`bash safe\u{200B}.sh`);
    expect((request["systemRunPlan"] as { commandText?: string }).commandText).toBe(
      "bash safe\u200B.sh",
    );
  });

  it("accepts resolve during broadcast", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const resolveRespond = vi.fn();

    const resolveContext = {
      broadcast: () => {},
    };

    const context = {
      broadcast: (event: string, payload: unknown) => {
        if (event !== "exec.approval.requested") {
          return;
        }
        const id = (payload as { id?: string })?.id ?? "";
        void resolveExecApproval({
          context: resolveContext,
          handlers,
          id,
          respond: resolveRespond,
        });
      },
    };

    await requestExecApproval({
      context,
      handlers,
      respond,
    });

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once" }),
      undefined,
    );
  });

  it("accepts explicit approval ids", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", id: "approval-123" },
      respond,
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).toBe("approval-123");

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      context,
      handlers,
      id,
      respond: resolveRespond,
    });

    await requestPromise;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once", id: "approval-123" }),
      undefined,
    );
    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("rejects explicit approval ids with the reserved plugin prefix", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();

    await requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", id: "plugin:approval-123" },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "approval ids starting with plugin: are reserved",
      }),
    );
  });

  it("accepts unique short approval id prefixes", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
    };

    const record = manager.create({ command: "echo ok" }, 60_000, "approval-12345678-aaaa");
    void manager.register(record, 60_000);

    await resolveExecApproval({
      context,
      handlers,
      id: "approval-1234",
      respond,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(manager.getSnapshot(record.id)?.decision).toBe("allow-once");
  });

  it("rejects ambiguous short approval id prefixes without leaking candidate ids", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
    };

    void manager.register(
      manager.create({ command: "echo one" }, 60_000, "approval-abcd-1111"),
      60_000,
    );
    void manager.register(
      manager.create({ command: "echo two" }, 60_000, "approval-abcd-2222"),
      60_000,
    );

    await resolveExecApproval({
      context,
      handlers,
      id: "approval-abcd",
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "ambiguous approval id prefix; use the full id",
      }),
    );
  });

  it("returns deterministic unknown/expired message for missing approval ids", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();

    await resolveExecApproval({
      context,
      handlers,
      id: "missing-approval-id",
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: expect.objectContaining({ reason: "APPROVAL_NOT_FOUND" }),
        message: "unknown or expired approval id",
      }),
    );
  });

  it("resolves only the targeted approval id when multiple requests are pending", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const context = {
      broadcast: (_event: string, _payload: unknown) => {},
      hasExecApprovalClients: () => true,
    };
    const respondOne = vi.fn();
    const respondTwo = vi.fn();

    const requestOne = requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", id: "approval-one", timeoutMs: 60_000 },
      respond: respondOne,
    });
    const requestTwo = requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", id: "approval-two", timeoutMs: 60_000 },
      respond: respondTwo,
    });

    await drainApprovalRequestTicks();

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      context,
      handlers,
      id: "approval-one",
      respond: resolveRespond,
    });

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(manager.getSnapshot("approval-one")?.decision).toBe("allow-once");
    expect(manager.getSnapshot("approval-two")?.decision).toBeUndefined();
    expect(manager.getSnapshot("approval-two")?.resolvedAtMs).toBeUndefined();

    expect(manager.expire("approval-two", "test-expire")).toBe(true);
    await requestOne;
    await requestTwo;

    expect(respondOne).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once", id: "approval-one" }),
      undefined,
    );
    expect(respondTwo).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: null, id: "approval-two" }),
      undefined,
    );
  });

  it("forwards turn-source metadata to exec approval forwarding", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, forwarder, respond, context } = createForwardingExecApprovalFixture();

      const requestPromise = requestExecApproval({
        context,
        handlers,
        params: {
          timeoutMs: 60_000,
          turnSourceAccountId: "work",
          turnSourceChannel: "whatsapp",
          turnSourceThreadId: "1739201675.123",
          turnSourceTo: "+15555550123",
        },
        respond,
      });
      await drainApprovalRequestTicks();
      expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
      expect(forwarder.handleRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            turnSourceAccountId: "work",
            turnSourceChannel: "whatsapp",
            turnSourceThreadId: "1739201675.123",
            turnSourceTo: "+15555550123",
          }),
        }),
      );

      await vi.runOnlyPendingTimersAsync();
      await requestPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fast-fails approvals when no approver clients and no forwarding targets", async () => {
    const { manager, handlers, forwarder, respond, context } =
      createForwardingExecApprovalFixture();
    const expireSpy = vi.spyOn(manager, "expire");

    await requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", id: "approval-no-approver", timeoutMs: 60_000 },
      respond,
    });

    expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
    expect(expireSpy).toHaveBeenCalledWith("approval-no-approver", "no-approval-route");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: null, id: "approval-no-approver" }),
      undefined,
    );
  });

  it("keeps approvals pending when iOS push delivery accepted the request", async () => {
    const iosPushDelivery = {
      handleExpired: vi.fn(async () => {}),
      handleRequested: vi.fn(async () => true),
      handleResolved: vi.fn(async () => {}),
    };
    const { manager, handlers, forwarder, respond, context } = createForwardingExecApprovalFixture({
      iosPushDelivery,
    });
    const expireSpy = vi.spyOn(manager, "expire");

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: {
        host: "gateway",
        id: "approval-ios-push",
        timeoutMs: 60_000,
        twoPhase: true,
      },
      respond,
    });

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ id: "approval-ios-push", status: "accepted" }),
        undefined,
      );
    });

    expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
    expect(iosPushDelivery.handleRequested).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval-ios-push" }),
    );
    expect(expireSpy).not.toHaveBeenCalled();

    manager.resolve("approval-ios-push", "allow-once");
    await requestPromise;
  });

  it("sends iOS cleanup delivery on resolve", async () => {
    const iosPushDelivery = {
      handleExpired: vi.fn(async () => {}),
      handleRequested: vi.fn(async () => true),
      handleResolved: vi.fn(async () => {}),
    };
    const { handlers, respond, context } = createForwardingExecApprovalFixture({ iosPushDelivery });
    const resolveRespond = vi.fn();

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", id: "approval-ios-cleanup", timeoutMs: 60_000 },
      respond,
    });
    await drainApprovalRequestTicks();

    await resolveExecApproval({
      context,
      handlers,
      id: "approval-ios-cleanup",
      respond: resolveRespond,
    });
    await requestPromise;

    await vi.waitFor(() => {
      expect(iosPushDelivery.handleResolved).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "allow-once", id: "approval-ios-cleanup" }),
      );
    });
  });

  it("sends iOS cleanup delivery on expiration", async () => {
    vi.useFakeTimers();
    try {
      const iosPushDelivery = {
        handleExpired: vi.fn(async () => {}),
        handleRequested: vi.fn(async () => true),
        handleResolved: vi.fn(async () => {}),
      };
      const { handlers, respond, context } = createForwardingExecApprovalFixture({
        iosPushDelivery,
      });

      const requestPromise = requestExecApproval({
        context,
        handlers,
        params: {
          host: "gateway",
          id: "approval-ios-expire",
          timeoutMs: 250,
          twoPhase: true,
        },
        respond,
      });
      await drainApprovalRequestTicks();
      await vi.advanceTimersByTimeAsync(250);
      await requestPromise;

      await vi.waitFor(() => {
        expect(iosPushDelivery.handleExpired).toHaveBeenCalledWith(
          expect.objectContaining({ id: "approval-ios-expire" }),
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps approvals pending when the originating chat can handle /approve directly", async () => {
    vi.useFakeTimers();
    try {
      const { manager, handlers, forwarder, respond, context } =
        createForwardingExecApprovalFixture();
      const expireSpy = vi.spyOn(manager, "expire");

      const requestPromise = requestExecApproval({
        context,
        handlers,
        params: {
          host: "gateway",
          id: "approval-chat-route",
          timeoutMs: 60_000,
          turnSourceChannel: "slack",
          turnSourceTo: "D123",
          twoPhase: true,
        },
        respond,
      });

      await vi.waitFor(() => {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ id: "approval-chat-route", status: "accepted" }),
          undefined,
        );
      });

      expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
      expect(expireSpy).not.toHaveBeenCalled();

      manager.resolve("approval-chat-route", "allow-once");
      await requestPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps approvals pending when no approver clients but forwarding accepted the request", async () => {
    const { manager, handlers, forwarder, respond, context } =
      createForwardingExecApprovalFixture();
    const expireSpy = vi.spyOn(manager, "expire");
    const resolveRespond = vi.fn();
    forwarder.handleRequested.mockResolvedValueOnce(true);

    const requestPromise = requestExecApproval({
      context,
      handlers,
      params: { host: "gateway", id: "approval-forwarded", timeoutMs: 60_000 },
      respond,
    });
    await drainApprovalRequestTicks();

    expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
    expect(expireSpy).not.toHaveBeenCalled();

    await resolveExecApproval({
      context,
      handlers,
      id: "approval-forwarded",
      respond: resolveRespond,
    });
    await requestPromise;

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once", id: "approval-forwarded" }),
      undefined,
    );
  });
});

describe("gateway healthHandlers.status scope handling", () => {
  let statusModule: typeof import("../../commands/status.js");
  let healthHandlers: typeof import("./health.js").healthHandlers;

  beforeAll(async () => {
    statusModule = await import("../../commands/status.js");
    ({ healthHandlers } = await import("./health.js"));
  });

  beforeEach(() => {
    vi.mocked(statusModule.getStatusSummary).mockClear();
  });

  async function runHealthStatus(scopes: string[]) {
    const respond = vi.fn();

    await healthHandlers.status({
      client: { connect: { role: "operator", scopes } } as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {} as never,
      req: {} as never,
      respond: respond as never,
    });

    return respond;
  }

  it.each([
    { includeSensitive: false, scopes: ["operator.read"] },
    { includeSensitive: true, scopes: ["operator.admin"] },
  ])(
    "requests includeSensitive=$includeSensitive for scopes $scopes",
    async ({ scopes, includeSensitive }) => {
      const respond = await runHealthStatus(scopes);

      expect(vi.mocked(statusModule.getStatusSummary)).toHaveBeenCalledWith({ includeSensitive });
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    },
  );
});

describe("logs.tail", () => {
  const logsNoop = () => false;

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("falls back to latest rolling log file when today is missing", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-logs-"));
    const older = path.join(tempDir, "openclaw-2026-01-20.log");
    const newer = path.join(tempDir, "openclaw-2026-01-21.log");

    await fsPromises.writeFile(older, '{"msg":"old"}\n');
    await fsPromises.writeFile(newer, '{"msg":"new"}\n');
    await fsPromises.utimes(older, new Date(0), new Date(0));
    await fsPromises.utimes(newer, new Date(), new Date());

    setLoggerOverride({ file: path.join(tempDir, "openclaw-2026-01-22.log") });

    const respond = vi.fn();
    await logsHandlers["logs.tail"]({
      client: null,
      context: {} as unknown as Parameters<(typeof logsHandlers)["logs.tail"]>[0]["context"],
      isWebchatConnect: logsNoop,
      params: {},
      req: { id: "req-1", method: "logs.tail", type: "req" },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file: newer,
        lines: ['{"msg":"new"}'],
      }),
      undefined,
    );

    await fsPromises.rm(tempDir, { force: true, recursive: true });
  });
});
