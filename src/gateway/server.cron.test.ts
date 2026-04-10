import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import {
  connectOk,
  cronIsolatedRun,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  waitForSystemEvent,
} from "./test-helpers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: GuardedFetchOptions) => ({
    finalUrl: params.url,
    release: async () => {},
    response: new Response("ok", { status: 200 }),
  })),
);

const sendFailureNotificationAnnounceMock = vi.hoisted(() => vi.fn(async () => undefined));
const closeTrackedBrowserTabsForSessionsMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    (
      fetchWithSsrFGuardMock as unknown as (...innerArgs: unknown[]) => Promise<{
        response: Response;
        finalUrl: string;
        release: () => Promise<void>;
      }>
    )(...args),
}));

vi.mock("../cron/delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../cron/delivery.js")>("../cron/delivery.js");
  return {
    ...actual,
    sendFailureNotificationAnnounce: (...args: unknown[]) =>
      (
        sendFailureNotificationAnnounceMock as unknown as (...innerArgs: unknown[]) => Promise<void>
      )(...args),
  };
});

vi.mock("../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsMock,
}));

installGatewayTestHooks({ scope: "suite" });
const CRON_WAIT_TIMEOUT_MS = 3000;
const EMPTY_CRON_STORE_CONTENT = JSON.stringify({ jobs: [], version: 1 });
let cronSuiteTempRootPromise: Promise<string> | null = null;
let cronSuiteCaseId = 0;

async function getCronSuiteTempRoot(): Promise<string> {
  if (!cronSuiteTempRootPromise) {
    cronSuiteTempRootPromise = fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-suite-"));
  }
  return await cronSuiteTempRootPromise;
}

async function yieldToEventLoop() {
  await setImmediatePromise();
}

async function rmTempDir(dir: string) {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fs.rm(dir, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        await yieldToEventLoop();
        continue;
      }
      throw error;
    }
  }
  await fs.rm(dir, { force: true, recursive: true });
}

async function waitForCronEvent(
  ws: WebSocket,
  check: (payload: Record<string, unknown> | null) => boolean,
  timeoutMs = CRON_WAIT_TIMEOUT_MS,
) {
  const message = await onceMessage(
    ws,
    (obj) => {
      const payload = obj.payload ?? null;
      return obj.type === "event" && obj.event === "cron" && check(payload);
    },
    timeoutMs,
  );
  return message.payload ?? null;
}

async function createCronCasePaths(tempPrefix: string): Promise<{
  dir: string;
  storePath: string;
}> {
  const suiteRoot = await getCronSuiteTempRoot();
  const dir = path.join(suiteRoot, `${tempPrefix}${cronSuiteCaseId++}`);
  const storePath = path.join(dir, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  return { dir, storePath };
}

async function cleanupCronTestRun(params: {
  ws: { close: () => void };
  server: { close: () => Promise<void> };
  prevSkipCron: string | undefined;
  clearSessionConfig?: boolean;
}) {
  params.ws.close();
  await params.server.close();
  testState.cronStorePath = undefined;
  if (params.clearSessionConfig) {
    testState.sessionConfig = undefined;
  }
  testState.cronEnabled = undefined;
  if (params.prevSkipCron === undefined) {
    delete process.env.OPENCLAW_SKIP_CRON;
    return;
  }
  process.env.OPENCLAW_SKIP_CRON = params.prevSkipCron;
}

async function setupCronTestRun(params: {
  tempPrefix: string;
  cronEnabled?: boolean;
  sessionConfig?: { mainKey: string };
  jobs?: unknown[];
}): Promise<{ prevSkipCron: string | undefined; dir: string }> {
  const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
  process.env.OPENCLAW_SKIP_CRON = "0";
  const { dir, storePath } = await createCronCasePaths(params.tempPrefix);
  testState.cronStorePath = storePath;
  testState.sessionConfig = params.sessionConfig;
  testState.cronEnabled = params.cronEnabled;
  await fs.writeFile(
    testState.cronStorePath,
    params.jobs ? JSON.stringify({ jobs: params.jobs, version: 1 }) : EMPTY_CRON_STORE_CONTENT,
  );
  return { dir, prevSkipCron };
}

function expectCronJobIdFromResponse(response: { ok?: unknown; payload?: unknown }) {
  expect(response.ok).toBe(true);
  const value = (response.payload as { id?: unknown } | null)?.id;
  const id = typeof value === "string" ? value : "";
  expect(id.length > 0).toBe(true);
  return id;
}

async function addMainSystemEventCronJob(params: { ws: WebSocket; name: string; text?: string }) {
  const response = await rpcReq(params.ws, "cron.add", {
    enabled: true,
    name: params.name,
    payload: { kind: "systemEvent", text: params.text ?? "hello" },
    schedule: { everyMs: 60_000, kind: "every" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
  });
  return expectCronJobIdFromResponse(response);
}

async function addWebhookCronJob(params: {
  ws: WebSocket;
  name: string;
  sessionTarget?: "main" | "isolated";
  payloadText?: string;
  delivery: Record<string, unknown>;
}) {
  const response = await rpcReq(params.ws, "cron.add", {
    delivery: params.delivery,
    enabled: true,
    name: params.name,
    payload: {
      kind: params.sessionTarget === "isolated" ? "agentTurn" : "systemEvent",
      ...(params.sessionTarget === "isolated"
        ? { message: params.payloadText ?? "test" }
        : { text: params.payloadText ?? "send webhook" }),
    },
    schedule: { everyMs: 60_000, kind: "every" },
    sessionTarget: params.sessionTarget ?? "main",
    wakeMode: "next-heartbeat",
  });
  return expectCronJobIdFromResponse(response);
}

async function writeCronConfig(config: unknown) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  expect(typeof configPath).toBe("string");
  await fs.mkdir(path.dirname(configPath as string), { recursive: true });
  await fs.writeFile(configPath as string, JSON.stringify(config, null, 2), "utf8");
}

async function runCronJobForce(ws: WebSocket, id: string) {
  const response = await rpcReq(ws, "cron.run", { id, mode: "force" }, 20_000);
  expect(response.ok).toBe(true);
  expect(response.payload).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
  return response;
}

async function runCronJobAndWaitForFinished(ws: WebSocket, jobId: string) {
  const finished = waitForCronEvent(
    ws,
    (payload) => payload?.jobId === jobId && payload?.action === "finished",
  );
  await runCronJobForce(ws, jobId);
  await finished;
}

function getWebhookCall(index: number) {
  const [args] = fetchWithSsrFGuardMock.mock.calls[index] as unknown as [
    {
      url?: string;
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      };
    },
  ];
  const url = args.url ?? "";
  const init = args.init ?? {};
  const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
  return { body, init, url };
}

describe("gateway server cron", () => {
  afterAll(async () => {
    if (!cronSuiteTempRootPromise) {
      return;
    }
    await rmTempDir(await cronSuiteTempRootPromise);
    cronSuiteTempRootPromise = null;
    cronSuiteCaseId = 0;
  });

  beforeEach(() => {
    // Keep polling helpers deterministic even if other tests left fake timers enabled.
    vi.useRealTimers();
    sendFailureNotificationAnnounceMock.mockClear();
    closeTrackedBrowserTabsForSessionsMock.mockClear();
  });

  test("handles cron CRUD, normalization, and patch semantics", { timeout: 45_000 }, async () => {
    const { prevSkipCron } = await setupCronTestRun({
      cronEnabled: false,
      sessionConfig: { mainKey: "primary" },
      tempPrefix: "openclaw-gw-cron-",
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const addRes = await rpcReq(ws, "cron.add", {
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
        enabled: true,
        name: "daily",
        payload: { kind: "systemEvent", text: "hello" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      expect(addRes.ok).toBe(true);
      expect(typeof (addRes.payload as { id?: unknown } | null)?.id).toBe("string");

      const listRes = await rpcReq(ws, "cron.list", {
        includeDisabled: true,
      });
      expect(listRes.ok).toBe(true);
      const jobs = (listRes.payload as { jobs?: unknown } | null)?.jobs;
      expect(Array.isArray(jobs)).toBe(true);
      expect((jobs as unknown[]).length).toBe(1);
      expect(((jobs as { name?: unknown }[])[0]?.name as string) ?? "").toBe("daily");
      expect(
        ((jobs as { delivery?: { mode?: unknown } }[])[0]?.delivery?.mode as string) ?? "",
      ).toBe("webhook");

      const routeAtMs = Date.now() - 1;
      const routeRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "route test",
        payload: { kind: "systemEvent", text: "cron route check" },
        schedule: { at: new Date(routeAtMs).toISOString(), kind: "at" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      expect(routeRes.ok).toBe(true);
      const routeJobIdValue = (routeRes.payload as { id?: unknown } | null)?.id;
      const routeJobId = typeof routeJobIdValue === "string" ? routeJobIdValue : "";
      expect(routeJobId.length > 0).toBe(true);

      const runRes = await rpcReq(ws, "cron.run", { id: routeJobId, mode: "force" }, 20_000);
      expect(runRes.ok).toBe(true);
      expect(runRes.payload).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
      const events = await waitForSystemEvent();
      expect(events.some((event) => event.includes("cron route check"))).toBe(true);

      const wrappedAtMs = Date.now() + 1000;
      const wrappedRes = await rpcReq(ws, "cron.add", {
        data: {
          name: "wrapped",
          payload: { kind: "systemEvent", text: "hello" },
          schedule: { at: new Date(wrappedAtMs).toISOString() },
        },
      });
      expect(wrappedRes.ok).toBe(true);
      const wrappedPayload = wrappedRes.payload as
        | { schedule?: unknown; sessionTarget?: unknown; wakeMode?: unknown }
        | undefined;
      expect(wrappedPayload?.sessionTarget).toBe("main");
      expect(wrappedPayload?.wakeMode).toBe("now");
      expect((wrappedPayload?.schedule as { kind?: unknown } | undefined)?.kind).toBe("at");

      const patchJobId = await addMainSystemEventCronJob({ name: "patch test", ws });

      const atMs = Date.now() + 1000;
      const updateRes = await rpcReq(ws, "cron.update", {
        id: patchJobId,
        patch: {
          payload: { kind: "systemEvent", text: "updated" },
          schedule: { at: new Date(atMs).toISOString() },
        },
      });
      expect(updateRes.ok).toBe(true);
      const updated = updateRes.payload as
        | { schedule?: { kind?: unknown }; payload?: { kind?: unknown } }
        | undefined;
      expect(updated?.schedule?.kind).toBe("at");
      expect(updated?.payload?.kind).toBe("systemEvent");

      const mergeRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "patch merge",
        payload: { kind: "agentTurn", message: "hello", model: "opus" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
      });
      expect(mergeRes.ok).toBe(true);
      const mergeJobIdValue = (mergeRes.payload as { id?: unknown } | null)?.id;
      const mergeJobId = typeof mergeJobIdValue === "string" ? mergeJobIdValue : "";
      expect(mergeJobId.length > 0).toBe(true);

      const noTimeoutRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "no-timeout payload",
        payload: { kind: "agentTurn", message: "hello", timeoutSeconds: 0 },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
      });
      expect(noTimeoutRes.ok).toBe(true);
      const noTimeoutPayload = noTimeoutRes.payload as
        | {
            payload?: {
              kind?: unknown;
              timeoutSeconds?: unknown;
            };
          }
        | undefined;
      expect(noTimeoutPayload?.payload?.kind).toBe("agentTurn");
      expect(noTimeoutPayload?.payload?.timeoutSeconds).toBe(0);

      const mergeUpdateRes = await rpcReq(ws, "cron.update", {
        id: mergeJobId,
        patch: {
          delivery: { channel: "telegram", mode: "announce", to: "19098680" },
        },
      });
      expect(mergeUpdateRes.ok).toBe(true);
      const merged = mergeUpdateRes.payload as
        | {
            payload?: { kind?: unknown; message?: unknown; model?: unknown };
            delivery?: { mode?: unknown; channel?: unknown; to?: unknown };
          }
        | undefined;
      expect(merged?.payload?.kind).toBe("agentTurn");
      expect(merged?.payload?.message).toBe("hello");
      expect(merged?.payload?.model).toBe("opus");
      expect(merged?.delivery?.mode).toBe("announce");
      expect(merged?.delivery?.channel).toBe("telegram");
      expect(merged?.delivery?.to).toBe("19098680");

      const modelOnlyPatchRes = await rpcReq(ws, "cron.update", {
        id: mergeJobId,
        patch: {
          payload: {
            model: "anthropic/claude-sonnet-4-6",
          },
        },
      });
      expect(modelOnlyPatchRes.ok).toBe(true);
      const modelOnlyPatched = modelOnlyPatchRes.payload as
        | {
            payload?: {
              kind?: unknown;
              message?: unknown;
              model?: unknown;
            };
          }
        | undefined;
      expect(modelOnlyPatched?.payload?.kind).toBe("agentTurn");
      expect(modelOnlyPatched?.payload?.message).toBe("hello");
      expect(modelOnlyPatched?.payload?.model).toBe("anthropic/claude-sonnet-4-6");

      const deliveryPatchRes = await rpcReq(ws, "cron.update", {
        id: mergeJobId,
        patch: {
          delivery: {
            bestEffort: true,
            channel: "signal",
            mode: "announce",
            to: "+15550001111",
          },
        },
      });
      expect(deliveryPatchRes.ok).toBe(true);
      const deliveryPatched = deliveryPatchRes.payload as
        | {
            payload?: { kind?: unknown; message?: unknown };
            delivery?: { mode?: unknown; channel?: unknown; to?: unknown; bestEffort?: unknown };
          }
        | undefined;
      expect(deliveryPatched?.payload?.kind).toBe("agentTurn");
      expect(deliveryPatched?.payload?.message).toBe("hello");
      expect(deliveryPatched?.delivery?.mode).toBe("announce");
      expect(deliveryPatched?.delivery?.channel).toBe("signal");
      expect(deliveryPatched?.delivery?.to).toBe("+15550001111");
      expect(deliveryPatched?.delivery?.bestEffort).toBe(true);

      const rejectJobId = await addMainSystemEventCronJob({ name: "patch reject", ws });

      const rejectUpdateRes = await rpcReq(ws, "cron.update", {
        id: rejectJobId,
        patch: {
          payload: { kind: "agentTurn", message: "nope" },
        },
      });
      expect(rejectUpdateRes.ok).toBe(false);

      const jobId = await addMainSystemEventCronJob({ name: "jobId test", ws });

      const jobIdUpdateRes = await rpcReq(ws, "cron.update", {
        jobId,
        patch: {
          payload: { kind: "systemEvent", text: "updated" },
          schedule: { at: new Date(Date.now() + 2000).toISOString() },
        },
      });
      expect(jobIdUpdateRes.ok).toBe(true);

      const disableJobId = await addMainSystemEventCronJob({ name: "disable test", ws });

      const disableUpdateRes = await rpcReq(ws, "cron.update", {
        id: disableJobId,
        patch: { enabled: false },
      });
      expect(disableUpdateRes.ok).toBe(true);
      const disabled = disableUpdateRes.payload as { enabled?: unknown } | undefined;
      expect(disabled?.enabled).toBe(false);
    } finally {
      await cleanupCronTestRun({
        clearSessionConfig: true,
        prevSkipCron,
        server,
        ws,
      });
    }
  });

  test("rejects unsafe custom session ids on add and update", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      cronEnabled: false,
      tempPrefix: "openclaw-gw-cron-bad-session-target-",
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const addRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "bad custom session",
        payload: { kind: "agentTurn", message: "hello" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "session:../../outside",
        wakeMode: "now",
      });
      expect(addRes.ok).toBe(false);
      expect(addRes.error?.message).toContain("invalid cron sessionTarget session id");

      const validRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "good custom session",
        payload: { kind: "agentTurn", message: "hello" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "session:project-alpha:ops",
        wakeMode: "now",
      });
      expect(validRes.ok).toBe(true);
      const jobId = (validRes.payload as { id?: unknown } | null)?.id;
      expect(typeof jobId).toBe("string");

      const updateRes = await rpcReq(ws, "cron.update", {
        id: jobId,
        patch: {
          sessionTarget: "session:..\\outside",
        },
      });
      expect(updateRes.ok).toBe(false);
      expect(updateRes.error?.message).toContain("invalid cron sessionTarget session id");
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  });

  test("writes cron run history and auto-runs due jobs", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-log-",
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const atMs = Date.now() - 1;
      const addRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "log test",
        payload: { kind: "systemEvent", text: "hello" },
        schedule: { at: new Date(atMs).toISOString(), kind: "at" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const finishedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "finished",
      );
      const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 20_000);
      expect(runRes.ok).toBe(true);
      expect(runRes.payload).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
      const finishedPayload = await finishedRun;
      expect(finishedPayload).toMatchObject({
        action: "finished",
        deliveryStatus: "not-requested",
        jobId,
        status: "ok",
        summary: "hello",
      });

      const runsRes = await rpcReq(ws, "cron.runs", { id: jobId, limit: 50 });
      expect(runsRes.ok).toBe(true);
      const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
      expect(Array.isArray(entries)).toBe(true);
      expect((entries as { jobId?: unknown }[]).at(-1)?.jobId).toBe(jobId);
      expect((entries as { summary?: unknown }[]).at(-1)?.summary).toBe("hello");
      expect((entries as { deliveryStatus?: unknown }[]).at(-1)?.deliveryStatus).toBe(
        "not-requested",
      );
      const allRunsRes = await rpcReq(ws, "cron.runs", {
        limit: 50,
        scope: "all",
        statuses: ["ok"],
      });
      expect(allRunsRes.ok).toBe(true);
      const allEntries = (allRunsRes.payload as { entries?: unknown } | null)?.entries;
      expect(Array.isArray(allEntries)).toBe(true);
      expect((allEntries as { jobId?: unknown }[]).some((entry) => entry.jobId === jobId)).toBe(
        true,
      );

      const statusRes = await rpcReq(ws, "cron.status", {});
      expect(statusRes.ok).toBe(true);
      const statusPayload = statusRes.payload as
        | { enabled?: unknown; storePath?: unknown }
        | undefined;
      expect(statusPayload?.enabled).toBe(true);
      const storePath = typeof statusPayload?.storePath === "string" ? statusPayload.storePath : "";
      expect(storePath).toContain("jobs.json");

      const autoRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "auto run test",
        payload: { kind: "systemEvent", text: "auto" },
        schedule: { at: new Date(Date.now() + 200).toISOString(), kind: "at" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      expect(autoRes.ok).toBe(true);
      const autoJobIdValue = (autoRes.payload as { id?: unknown } | null)?.id;
      const autoJobId = typeof autoJobIdValue === "string" ? autoJobIdValue : "";
      expect(autoJobId.length > 0).toBe(true);

      await waitForCronEvent(
        ws,
        (payload) => payload?.jobId === autoJobId && payload?.action === "finished",
      );
      const autoEntries = (await rpcReq(ws, "cron.runs", { id: autoJobId, limit: 10 })).payload as
        | { entries?: { jobId?: unknown }[] }
        | undefined;
      expect(Array.isArray(autoEntries?.entries)).toBe(true);
      const runs = autoEntries?.entries ?? [];
      expect(runs.at(-1)?.jobId).toBe(autoJobId);
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  }, 45_000);

  test("fails closed for persisted unsafe custom session ids", async () => {
    const now = Date.now();
    const { prevSkipCron } = await setupCronTestRun({
      cronEnabled: false,
      jobs: [
        {
          createdAtMs: now,
          enabled: true,
          id: "bad-custom-session-job",
          name: "bad custom session job",
          payload: { kind: "agentTurn", message: "hello" },
          schedule: { everyMs: 60_000, kind: "every" },
          sessionTarget: "session:../../outside",
          state: {},
          updatedAtMs: now,
          wakeMode: "now",
        },
      ],
      tempPrefix: "openclaw-gw-cron-persisted-bad-session-target-",
    });

    cronIsolatedRun.mockClear();
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const runRes = await rpcReq(ws, "cron.run", {
        id: "bad-custom-session-job",
        mode: "force",
      });
      expect(runRes.ok).toBe(true);
      expect(runRes.payload).toEqual({ ok: true, ran: false, reason: "invalid-spec" });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  });

  test("returns from cron.run immediately while isolated work continues in background", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-run-detached-",
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
    cronIsolatedRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve as (value: { status: "ok"; summary: string }) => void;
        }),
    );

    try {
      const addRes = await rpcReq(ws, "cron.add", {
        delivery: { mode: "none" },
        enabled: true,
        name: "detached run test",
        payload: { kind: "agentTurn", message: "do work" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const startedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "started",
      );
      const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 1000);
      expect(runRes.ok).toBe(true);
      expect(runRes.payload).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
      await startedRun;
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const finishedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "finished",
      );
      resolveRun?.({ status: "ok", summary: "background finished" });
      const finishedPayload = await finishedRun;
      expect(finishedPayload).toMatchObject({
        action: "finished",
        jobId,
        status: "ok",
        summary: "background finished",
      });
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  });

  test("returns already-running without starting background work", async () => {
    const now = Date.now();
    let resolveRun: ((result: { status: "ok"; summary: string }) => void) | undefined;
    cronIsolatedRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const { prevSkipCron } = await setupCronTestRun({
      jobs: [
        {
          createdAtMs: now - 60_000,
          delivery: { mode: "none" },
          enabled: true,
          id: "busy-job",
          name: "busy job",
          payload: { kind: "agentTurn", message: "still busy" },
          schedule: { at: new Date(now + 60_000).toISOString(), kind: "at" },
          sessionTarget: "isolated",
          state: {
            nextRunAtMs: now + 60_000,
          },
          updatedAtMs: now - 60_000,
          wakeMode: "next-heartbeat",
        },
      ],
      tempPrefix: "openclaw-gw-cron-run-busy-",
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const startedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === "busy-job" && payload?.action === "started",
      );
      const firstRunRes = await rpcReq(ws, "cron.run", { id: "busy-job", mode: "force" }, 1000);
      expect(firstRunRes.ok).toBe(true);
      expect(firstRunRes.payload).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
      await startedRun;
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const secondRunRes = await rpcReq(ws, "cron.run", { id: "busy-job", mode: "force" }, 1000);
      expect(secondRunRes.ok).toBe(true);
      expect(secondRunRes.payload).toEqual({ ok: true, ran: false, reason: "already-running" });
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const finishedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === "busy-job" && payload?.action === "finished",
      );
      resolveRun?.({ status: "ok", summary: "busy done" });
      await finishedRun;
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  });

  test("returns not-due without starting background work", async () => {
    const now = Date.now();
    const { prevSkipCron } = await setupCronTestRun({
      jobs: [
        {
          createdAtMs: now - 60_000,
          delivery: { mode: "none" },
          enabled: true,
          id: "future-job",
          name: "future job",
          payload: { kind: "agentTurn", message: "not yet" },
          schedule: { at: new Date(now + 60_000).toISOString(), kind: "at" },
          sessionTarget: "isolated",
          state: {
            nextRunAtMs: now + 60_000,
          },
          updatedAtMs: now - 60_000,
          wakeMode: "next-heartbeat",
        },
      ],
      tempPrefix: "openclaw-gw-cron-run-not-due-",
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);
    cronIsolatedRun.mockClear();

    try {
      const runRes = await rpcReq(ws, "cron.run", { id: "future-job", mode: "due" }, 1000);
      expect(runRes.ok).toBe(true);
      expect(runRes.payload).toEqual({ ok: true, ran: false, reason: "not-due" });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  });

  test("posts webhooks for delivery mode and legacy notify fallback only when summary exists", async () => {
    const legacyNotifyJob = {
      createdAtMs: Date.now(),
      enabled: true,
      id: "legacy-notify-job",
      name: "legacy notify job",
      notify: true,
      payload: { kind: "systemEvent", text: "legacy webhook" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      state: {},
      updatedAtMs: Date.now(),
      wakeMode: "next-heartbeat",
    };
    const { prevSkipCron } = await setupCronTestRun({
      cronEnabled: false,
      jobs: [legacyNotifyJob],
      tempPrefix: "openclaw-gw-cron-webhook-",
    });

    await writeCronConfig({
      cron: {
        webhook: "https://legacy.example.invalid/cron-finished",
        webhookToken: "cron-webhook-token",
      },
    });

    fetchWithSsrFGuardMock.mockClear();

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const invalidWebhookRes = await rpcReq(ws, "cron.add", {
        delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
        enabled: true,
        name: "invalid webhook",
        payload: { kind: "systemEvent", text: "invalid" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      expect(invalidWebhookRes.ok).toBe(false);

      const notifyJobId = await addWebhookCronJob({
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
        name: "webhook enabled",
        ws,
      });
      await runCronJobAndWaitForFinished(ws, notifyJobId);
      const notifyCall = getWebhookCall(0);
      expect(notifyCall.url).toBe("https://example.invalid/cron-finished");
      expect(notifyCall.init.method).toBe("POST");
      expect(notifyCall.init.headers?.Authorization).toBe("Bearer cron-webhook-token");
      expect(notifyCall.init.headers?.["Content-Type"]).toBe("application/json");
      const notifyBody = notifyCall.body;
      expect(notifyBody.action).toBe("finished");
      expect(notifyBody.jobId).toBe(notifyJobId);

      const legacyFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === "legacy-notify-job" && payload?.action === "finished",
      );
      const legacyRunRes = await rpcReq(
        ws,
        "cron.run",
        { id: "legacy-notify-job", mode: "force" },
        20_000,
      );
      expect(legacyRunRes.ok).toBe(true);
      expect(legacyRunRes.payload).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
      await legacyFinished;
      const legacyCall = getWebhookCall(1);
      expect(legacyCall.url).toBe("https://legacy.example.invalid/cron-finished");
      expect(legacyCall.init.method).toBe("POST");
      expect(legacyCall.init.headers?.Authorization).toBe("Bearer cron-webhook-token");
      const legacyBody = legacyCall.body;
      expect(legacyBody.action).toBe("finished");
      expect(legacyBody.jobId).toBe("legacy-notify-job");

      const silentRes = await rpcReq(ws, "cron.add", {
        enabled: true,
        name: "webhook disabled",
        payload: { kind: "systemEvent", text: "do not send" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      expect(silentRes.ok).toBe(true);
      const silentJobIdValue = (silentRes.payload as { id?: unknown } | null)?.id;
      const silentJobId = typeof silentJobIdValue === "string" ? silentJobIdValue : "";
      expect(silentJobId.length > 0).toBe(true);

      const silentFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === silentJobId && payload?.action === "finished",
      );
      const silentRunRes = await rpcReq(ws, "cron.run", { id: silentJobId, mode: "force" }, 20_000);
      expect(silentRunRes.ok).toBe(true);
      expect(silentRunRes.payload).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
      await silentFinished;
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);

      fetchWithSsrFGuardMock.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", summary: "delivery failed" });
      const failureDestJobId = await addWebhookCronJob({
        delivery: {
          channel: "telegram",
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/failure-destination",
          },
          mode: "announce",
          to: "19098680",
        },
        name: "failure destination webhook",
        sessionTarget: "isolated",
        ws,
      });
      const failureDestFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === failureDestJobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, failureDestJobId);
      await failureDestFinished;
      const failureDestCall = getWebhookCall(0);
      expect(failureDestCall.url).toBe("https://example.invalid/failure-destination");
      const failureDestBody = failureDestCall.body;
      expect(failureDestBody.message).toBe(
        'Cron job "failure destination webhook" failed: unknown error',
      );

      fetchWithSsrFGuardMock.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", summary: "best-effort failed" });
      const bestEffortFailureDestJobId = await addWebhookCronJob({
        delivery: {
          bestEffort: true,
          channel: "telegram",
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/failure-destination",
          },
          mode: "announce",
          to: "19098680",
        },
        name: "best effort failure destination webhook",
        sessionTarget: "isolated",
        ws,
      });
      const bestEffortFailureDestFinished = waitForCronEvent(
        ws,
        (payload) =>
          payload?.jobId === bestEffortFailureDestJobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, bestEffortFailureDestJobId);
      await bestEffortFailureDestFinished;
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();

      cronIsolatedRun.mockResolvedValueOnce({ status: "ok", summary: "" });
      const noSummaryJobId = await addWebhookCronJob({
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
        name: "webhook no summary",
        sessionTarget: "isolated",
        ws,
      });
      const noSummaryFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === noSummaryJobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, noSummaryJobId);
      await noSummaryFinished;
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  }, 60_000);

  test("falls back to the primary delivery channel on job failure and preserves sessionKey", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      cronEnabled: false,
      tempPrefix: "openclaw-gw-cron-failure-primary-fallback-",
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", summary: "delivery failed" });
      const jobId = await addWebhookCronJob({
        delivery: {
          channel: "last",
          mode: "announce",
        },
        name: "primary delivery fallback",
        sessionTarget: "isolated",
        ws,
      });

      const updateRes = await rpcReq(ws, "cron.update", {
        id: jobId,
        patch: {
          sessionKey: "agent:main:telegram:direct:123:thread:99",
        },
      });
      expect(updateRes.ok).toBe(true);

      const finished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, jobId);
      await finished;

      expect(sendFailureNotificationAnnounceMock).toHaveBeenCalledTimes(1);
      expect(sendFailureNotificationAnnounceMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.any(String),
        jobId,
        {
          accountId: undefined,
          channel: "last",
          sessionKey: "agent:main:telegram:direct:123:thread:99",
          to: undefined,
        },
        '⚠️ Cron job "primary delivery fallback" failed: unknown error',
      );
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  }, 45_000);

  test("ignores non-string cron.webhookToken values without crashing webhook delivery", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      cronEnabled: false,
      tempPrefix: "openclaw-gw-cron-webhook-secretinput-",
    });

    await writeCronConfig({
      cron: {
        webhookToken: {
          opaque: true,
        },
      },
    });

    fetchWithSsrFGuardMock.mockClear();

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const notifyJobId = await addWebhookCronJob({
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
        name: "webhook secretinput object",
        ws,
      });
      await runCronJobAndWaitForFinished(ws, notifyJobId);
      const [notifyArgs] = fetchWithSsrFGuardMock.mock.calls[0] as unknown as [
        {
          url?: string;
          init?: {
            method?: string;
            headers?: Record<string, string>;
          };
        },
      ];
      expect(notifyArgs.url).toBe("https://example.invalid/cron-finished");
      expect(notifyArgs.init?.method).toBe("POST");
      expect(notifyArgs.init?.headers?.Authorization).toBeUndefined();
      expect(notifyArgs.init?.headers?.["Content-Type"]).toBe("application/json");
    } finally {
      await cleanupCronTestRun({ prevSkipCron, server, ws });
    }
  }, 45_000);
});
