import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import type { CronEvent, CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import { type CronServiceState, createCronServiceState } from "./service/state.js";
import type { CronJob } from "./types.js";

export interface NoopLogger {
  debug: MockFn;
  info: MockFn;
  warn: MockFn;
  error: MockFn;
}

export function createNoopLogger(): NoopLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

export function createCronStoreHarness(options?: { prefix?: string }) {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "openclaw-cron-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  });

  async function makeStorePath() {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dir, { recursive: true });
    return {
      cleanup: async () => {},
      storePath: path.join(dir, "cron", "jobs.json"),
    };
  }

  return { makeStorePath };
}

export async function writeCronStoreSnapshot(params: { storePath: string; jobs: CronJob[] }) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify(
      {
        jobs: params.jobs,
        version: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function installCronTestHooks(options: {
  logger: ReturnType<typeof createNoopLogger>;
  baseTimeIso?: string;
}) {
  beforeEach(() => {
    vi.useFakeTimers();
    // Shared unit-thread workers run with isolate disabled, so leaked cron
    // Timers from a previous file can still sit in the fake-timer queue.
    // Clear them before advancing time in the next test file.
    vi.clearAllTimers();
    vi.setSystemTime(new Date(options.baseTimeIso ?? "2025-12-13T00:00:00.000Z"));
    options.logger.debug.mockClear();
    options.logger.info.mockClear();
    options.logger.warn.mockClear();
    options.logger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}

export function setupCronServiceSuite(options?: { prefix?: string; baseTimeIso?: string }) {
  const logger = createNoopLogger();
  const { makeStorePath } = createCronStoreHarness({ prefix: options?.prefix });
  installCronTestHooks({
    baseTimeIso: options?.baseTimeIso,
    logger,
  });
  return { logger, makeStorePath };
}

export function createFinishedBarrier() {
  const resolvers = new Map<string, (evt: CronEvent) => void>();
  return {
    onEvent: (evt: CronEvent) => {
      if (evt.action !== "finished" || evt.status !== "ok") {
        return;
      }
      const resolve = resolvers.get(evt.jobId);
      if (!resolve) {
        return;
      }
      resolvers.delete(evt.jobId);
      resolve(evt);
    },
    waitForOk: (jobId: string) =>
      new Promise<CronEvent>((resolve) => {
        resolvers.set(jobId, resolve);
      }),
  };
}

export function createStartedCronServiceWithFinishedBarrier(params: {
  storePath: string;
  logger: ReturnType<typeof createNoopLogger>;
}): {
  cron: CronService;
  enqueueSystemEvent: MockFn;
  requestHeartbeatNow: MockFn;
  finished: ReturnType<typeof createFinishedBarrier>;
} {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeatNow = vi.fn();
  const finished = createFinishedBarrier();
  const cron = new CronService({
    cronEnabled: true,
    enqueueSystemEvent,
    log: params.logger,
    onEvent: finished.onEvent,
    requestHeartbeatNow,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    storePath: params.storePath,
  });
  return { cron, enqueueSystemEvent, finished, requestHeartbeatNow };
}

export async function withCronServiceForTest(
  params: {
    makeStorePath: () => Promise<{ storePath: string; cleanup: () => Promise<void> }>;
    logger: ReturnType<typeof createNoopLogger>;
    cronEnabled: boolean;
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  },
  run: (context: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeatNow: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
): Promise<void> {
  const store = await params.makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeatNow = vi.fn();
  const cron = new CronService({
    cronEnabled: params.cronEnabled,
    enqueueSystemEvent,
    log: params.logger,
    requestHeartbeatNow,
    runIsolatedAgentJob:
      params.runIsolatedAgentJob ??
      (vi.fn(async () => ({ status: "ok" as const, summary: "done" })) as never),
    storePath: store.storePath,
  });

  await cron.start();
  try {
    await run({ cron, enqueueSystemEvent, requestHeartbeatNow });
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

export function createRunningCronServiceState(params: {
  storePath: string;
  log: ReturnType<typeof createNoopLogger>;
  nowMs: () => number;
  jobs: CronJob[];
}) {
  const state = createCronServiceState({
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    log: params.log,
    nowMs: params.nowMs,
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    storePath: params.storePath,
  });
  state.running = true;
  state.store = {
    jobs: params.jobs,
    version: 1,
  };
  return state;
}

export function disposeCronServiceState(state: { timer: NodeJS.Timeout | null }): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export async function withCronServiceStateForTest<T>(
  state: { timer: NodeJS.Timeout | null },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    disposeCronServiceState(state);
  }
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export function createMockCronStateForJobs(params: {
  jobs: CronJob[];
  nowMs?: number;
}): CronServiceState {
  const nowMs = params.nowMs ?? Date.now();
  return {
    deps: {
      cronEnabled: true,
      enqueueSystemEvent: () => {},
      log: {
        debug: () => {},
        error: () => {},
        info: () => {},
        warn: () => {},
      } as never,
      nowMs: () => nowMs,
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      storePath: "/mock/path",
    },
    op: Promise.resolve(),
    running: false,
    store: { jobs: params.jobs, version: 1 },
    storeFileMtimeMs: null,
    storeLoadedAtMs: nowMs,
    timer: null,
    warnedDisabled: false,
  };
}
