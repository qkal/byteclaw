import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import { describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
} from "../../../src/hooks/internal-hooks.js";
import {
  __testing,
  reconcileShortTermDreamingCronJob,
  registerShortTermPromotionDreaming,
  resolveShortTermPromotionDreamingConfig,
  runShortTermDreamingPromotionIfTriggered,
} from "./dreaming.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { constants } = __testing;
const { createTempWorkspace } = createMemoryCoreTestHarness();

type CronParam = NonNullable<Parameters<typeof reconcileShortTermDreamingCronJob>[0]["cron"]>;
type CronJobLike = Awaited<ReturnType<CronParam["list"]>>[number];
type CronAddInput = Parameters<CronParam["add"]>[0];
type CronPatch = Parameters<CronParam["update"]>[1];
type DreamingPluginApi = Parameters<typeof registerShortTermPromotionDreaming>[0];
interface DreamingPluginApiTestDouble {
  config: OpenClawConfig;
  pluginConfig: Record<string, unknown>;
  logger: ReturnType<typeof createLogger>;
  runtime: unknown;
  registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => void;
  on: ReturnType<typeof vi.fn>;
}

function createLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

async function writeDailyMemoryNote(
  workspaceDir: string,
  date: string,
  lines: string[],
): Promise<void> {
  const notePath = path.join(workspaceDir, "memory", `${date}.md`);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf8");
}

function createCronHarness(
  initialJobs: CronJobLike[] = [],
  opts?: { removeResult?: "boolean" | "unknown"; removeThrowsForIds?: string[] },
) {
  const jobs: CronJobLike[] = [...initialJobs];
  let listCalls = 0;
  const addCalls: CronAddInput[] = [];
  const updateCalls: { id: string; patch: CronPatch }[] = [];
  const removeCalls: string[] = [];

  const cron: CronParam = {
    async add(input) {
      addCalls.push(input);
      jobs.push({
        createdAtMs: Date.now(),
        description: input.description,
        enabled: input.enabled,
        id: `job-${jobs.length + 1}`,
        name: input.name,
        payload: { ...input.payload },
        schedule: { ...input.schedule },
        sessionTarget: input.sessionTarget,
        wakeMode: input.wakeMode,
      });
      return {};
    },
    async list() {
      listCalls += 1;
      return jobs.map((job) => ({
        ...job,
        ...(job.schedule ? { schedule: { ...job.schedule } } : {}),
        ...(job.payload ? { payload: { ...job.payload } } : {}),
      }));
    },
    async remove(id) {
      removeCalls.push(id);
      if (opts?.removeThrowsForIds?.includes(id)) {
        throw new Error(`remove failed for ${id}`);
      }
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index !== -1) {
        jobs.splice(index, 1);
      }
      if (opts?.removeResult === "unknown") {
        return {};
      }
      return { removed: index !== -1 };
    },
    async update(id, patch) {
      updateCalls.push({ id, patch });
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return {};
      }
      const current = jobs[index];
      jobs[index] = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.schedule ? { schedule: { ...patch.schedule } } : {}),
        ...(patch.sessionTarget ? { sessionTarget: patch.sessionTarget } : {}),
        ...(patch.wakeMode ? { wakeMode: patch.wakeMode } : {}),
        ...(patch.payload ? { payload: { ...patch.payload } } : {}),
      };
      return {};
    },
  };

  return {
    addCalls,
    cron,
    jobs,
    get listCalls() {
      return listCalls;
    },
    removeCalls,
    updateCalls,
  };
}

function getBeforeAgentReplyHandler(
  onMock: ReturnType<typeof vi.fn>,
): (
  event: { cleanedBody: string },
  ctx: { trigger?: string; workspaceDir?: string },
) => Promise<unknown> {
  const call = onMock.mock.calls.find(([eventName]) => eventName === "before_agent_reply");
  if (!call) {
    throw new Error("before_agent_reply hook was not registered");
  }
  return call[1] as (
    event: { cleanedBody: string },
    ctx: { trigger?: string; workspaceDir?: string },
  ) => Promise<unknown>;
}

function registerShortTermPromotionDreamingForTest(api: DreamingPluginApiTestDouble): void {
  registerShortTermPromotionDreaming(api as unknown as DreamingPluginApi);
}

describe("short-term dreaming config", () => {
  it("uses defaults and user timezone fallback", () => {
    const cfg = {
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveShortTermPromotionDreamingConfig({
      cfg,
      pluginConfig: {},
    });
    expect(resolved).toEqual({
      cron: constants.DEFAULT_DREAMING_CRON_EXPR,
      enabled: false,
      limit: constants.DEFAULT_DREAMING_LIMIT,
      maxAgeDays: 30,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      storage: {
        mode: "inline",
        separateReports: false,
      },
      timezone: "America/Los_Angeles",
      verboseLogging: false,
    });
  });

  it("reads explicit dreaming config values", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          frequency: "5 1 * * *",
          phases: {
            deep: {
              limit: 7,
              maxAgeDays: 30,
              minRecallCount: 2,
              minScore: 0.4,
              minUniqueQueries: 3,
              recencyHalfLifeDays: 21,
            },
          },
          timezone: "UTC",
          verboseLogging: true,
        },
      },
    });
    expect(resolved).toEqual({
      cron: "5 1 * * *",
      enabled: true,
      limit: 7,
      maxAgeDays: 30,
      minRecallCount: 2,
      minScore: 0.4,
      minUniqueQueries: 3,
      recencyHalfLifeDays: 21,
      storage: {
        mode: "inline",
        separateReports: false,
      },
      timezone: "UTC",
      verboseLogging: true,
    });
  });

  it("accepts top-level frequency and numeric string thresholds", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          frequency: "5 1 * * *",
          phases: {
            deep: {
              limit: "4",
              maxAgeDays: "45",
              minRecallCount: "2",
              minScore: "0.6",
              minUniqueQueries: "3",
              recencyHalfLifeDays: "9",
            },
          },
        },
      },
    });
    expect(resolved).toEqual({
      cron: "5 1 * * *",
      enabled: true,
      limit: 4,
      maxAgeDays: 45,
      minRecallCount: 2,
      minScore: 0.6,
      minUniqueQueries: 3,
      recencyHalfLifeDays: 9,
      storage: {
        mode: "inline",
        separateReports: false,
      },
      verboseLogging: false,
    });
  });

  it("treats blank numeric strings as unset and keeps preset defaults", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            deep: {
              limit: " ",
              maxAgeDays: " ",
              minRecallCount: "  ",
              minScore: "",
              minUniqueQueries: "",
              recencyHalfLifeDays: "",
            },
          },
        },
      },
    });
    expect(resolved).toEqual({
      cron: constants.DEFAULT_DREAMING_CRON_EXPR,
      enabled: true,
      limit: constants.DEFAULT_DREAMING_LIMIT,
      maxAgeDays: 30,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      storage: {
        mode: "inline",
        separateReports: false,
      },
      verboseLogging: false,
    });
  });

  it("accepts limit=0 as an explicit no-op promotion cap", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            deep: {
              limit: 0,
            },
          },
        },
      },
    });
    expect(resolved.limit).toBe(0);
  });

  it("accepts verboseLogging as a boolean or boolean string", () => {
    const enabled = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          verboseLogging: true,
        },
      },
    });
    const disabled = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          verboseLogging: "false",
        },
      },
    });

    expect(enabled.verboseLogging).toBe(true);
    expect(disabled.verboseLogging).toBe(false);
  });

  it("falls back to defaults when thresholds are negative", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            deep: {
              maxAgeDays: -5,
              minRecallCount: -2,
              minScore: -0.2,
              minUniqueQueries: -4,
              recencyHalfLifeDays: -10,
            },
          },
        },
      },
    });
    expect(resolved).toMatchObject({
      enabled: true,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
    });
    expect(resolved.maxAgeDays).toBe(30);
  });

  it("keeps deep sleep disabled when the phase is off", () => {
    const resolved = resolveShortTermPromotionDreamingConfig({
      pluginConfig: {
        dreaming: {
          phases: {
            deep: {
              enabled: false,
            },
          },
        },
      },
    });
    expect(resolved.enabled).toBe(false);
  });
});

describe("short-term dreaming startup event parsing", () => {
  it("resolves cron service from gateway startup event deps", () => {
    const harness = createCronHarness();
    const resolved = __testing.resolveCronServiceFromStartupEvent({
      action: "startup",
      context: {
        deps: {
          cron: harness.cron,
        },
      },
      type: "gateway",
    });
    expect(resolved).toBe(harness.cron);
  });
});

describe("short-term dreaming cron reconciliation", () => {
  it("creates a managed cron job when enabled", async () => {
    const harness = createCronHarness();
    const logger = createLogger();
    const result = await reconcileShortTermDreamingCronJob({
      config: {
        cron: "0 1 * * *",
        enabled: true,
        limit: 8,
        minRecallCount: 4,
        minScore: 0.5,
        minUniqueQueries: 5,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        timezone: "UTC",
        verboseLogging: false,
      },
      cron: harness.cron,
      logger,
    });

    expect(result.status).toBe("added");
    expect(harness.addCalls).toHaveLength(1);
    expect(harness.addCalls[0]).toMatchObject({
      name: constants.MANAGED_DREAMING_CRON_NAME,
      payload: {
        kind: "systemEvent",
        text: constants.DREAMING_SYSTEM_EVENT_TEXT,
      },
      schedule: {
        expr: "0 1 * * *",
        kind: "cron",
        tz: "UTC",
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });
  });

  it("updates drifted managed jobs and prunes duplicates", async () => {
    const desiredConfig = {
      cron: "0 3 * * *",
      enabled: true,
      limit: 10,
      minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
      minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
      minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
      recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
      timezone: "America/Los_Angeles",
      verboseLogging: false,
    } as const;
    const desired = __testing.buildManagedDreamingCronJob(desiredConfig);
    const stalePrimary: CronJobLike = {
      createdAtMs: 1,
      description: desired.description,
      enabled: false,
      id: "job-primary",
      name: desired.name,
      payload: {
        kind: "systemEvent",
        text: "stale-text",
      },
      schedule: { expr: "0 9 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const duplicate: CronJobLike = {
      ...desired,
      createdAtMs: 2,
      id: "job-duplicate",
    };
    const unmanaged: CronJobLike = {
      createdAtMs: 3,
      description: "not managed",
      enabled: true,
      id: "job-unmanaged",
      name: "other",
      payload: { kind: "systemEvent", text: "hello" },
      schedule: { expr: "0 8 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const harness = createCronHarness([stalePrimary, duplicate, unmanaged]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      config: desiredConfig,
      cron: harness.cron,
      logger,
    });

    expect(result.status).toBe("updated");
    expect(result.removed).toBe(1);
    expect(harness.removeCalls).toEqual(["job-duplicate"]);
    expect(harness.updateCalls).toHaveLength(1);
    expect(harness.updateCalls[0]).toMatchObject({
      id: "job-primary",
      patch: {
        enabled: true,
        payload: desired.payload,
        schedule: desired.schedule,
      },
    });
  });

  it("removes managed dreaming jobs when disabled", async () => {
    const managedJob: CronJobLike = {
      createdAtMs: 10,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} test`,
      enabled: true,
      id: "job-managed",
      name: constants.MANAGED_DREAMING_CRON_NAME,
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      schedule: { expr: "0 3 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const unmanagedJob: CronJobLike = {
      createdAtMs: 11,
      description: "other",
      enabled: true,
      id: "job-other",
      name: "Daily report",
      payload: { kind: "systemEvent", text: "report" },
      schedule: { expr: "0 7 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const harness = createCronHarness([managedJob, unmanagedJob]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: false,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      cron: harness.cron,
      logger,
    });

    expect(result).toEqual({ removed: 1, status: "disabled" });
    expect(harness.removeCalls).toEqual(["job-managed"]);
    expect(harness.jobs.map((entry) => entry.id)).toEqual(["job-other"]);
  });

  it("migrates legacy light/rem dreaming cron jobs during reconciliation", async () => {
    const deepManagedJob: CronJobLike = {
      createdAtMs: 10,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} test`,
      enabled: true,
      id: "job-deep",
      name: constants.MANAGED_DREAMING_CRON_NAME,
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      schedule: { expr: "0 3 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const legacyLightJob: CronJobLike = {
      createdAtMs: 8,
      description: "[managed-by=memory-core.dreaming.light] legacy",
      enabled: true,
      id: "job-light",
      name: "Memory Light Dreaming",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
      schedule: { expr: "0 */6 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const legacyRemJob: CronJobLike = {
      createdAtMs: 9,
      description: "[managed-by=memory-core.dreaming.rem] legacy",
      enabled: true,
      id: "job-rem",
      name: "Memory REM Dreaming",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_rem_sleep__" },
      schedule: { expr: "0 5 * * 0", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const harness = createCronHarness([legacyLightJob, legacyRemJob, deepManagedJob]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      cron: harness.cron,
      logger,
    });

    expect(result.status).toBe("updated");
    expect(result.removed).toBe(2);
    expect(harness.removeCalls).toEqual(["job-light", "job-rem"]);
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: migrated 2 legacy phase dreaming cron job(s) to the unified dreaming controller.",
    );
  });

  it("migrates legacy phase jobs even when unified dreaming is disabled", async () => {
    const legacyLightJob: CronJobLike = {
      createdAtMs: 8,
      description: "[managed-by=memory-core.dreaming.light] legacy",
      enabled: true,
      id: "job-light",
      name: "Memory Light Dreaming",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
      schedule: { expr: "0 */6 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const harness = createCronHarness([legacyLightJob]);
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: false,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      cron: harness.cron,
      logger,
    });

    expect(result).toEqual({ removed: 1, status: "disabled" });
    expect(harness.removeCalls).toEqual(["job-light"]);
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: completed legacy phase dreaming cron migration while unified dreaming is disabled (1 job(s) removed).",
    );
  });

  it("does not overcount removed jobs when cron remove result is unknown", async () => {
    const managedJob: CronJobLike = {
      createdAtMs: 10,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} test`,
      enabled: true,
      id: "job-managed",
      name: constants.MANAGED_DREAMING_CRON_NAME,
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      schedule: { expr: "0 3 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const harness = createCronHarness([managedJob], { removeResult: "unknown" });
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: false,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      cron: harness.cron,
      logger,
    });

    expect(result.removed).toBe(0);
    expect(harness.removeCalls).toEqual(["job-managed"]);
  });

  it("warns and continues when disabling managed jobs hits a remove error", async () => {
    const managedJob: CronJobLike = {
      createdAtMs: 10,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} test`,
      enabled: true,
      id: "job-managed",
      name: constants.MANAGED_DREAMING_CRON_NAME,
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      schedule: { expr: "0 3 * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    const harness = createCronHarness([managedJob], { removeThrowsForIds: ["job-managed"] });
    const logger = createLogger();

    const result = await reconcileShortTermDreamingCronJob({
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: false,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      cron: harness.cron,
      logger,
    });

    expect(result).toEqual({ removed: 0, status: "disabled" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to remove managed dreaming cron job job-managed"),
    );
  });
});

describe("gateway startup reconciliation", () => {
  it("uses the startup cfg when reconciling the managed dreaming cron job", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const api: DreamingPluginApiTestDouble = {
      config: { plugins: { entries: {} } },
      logger,
      on: vi.fn(),
      pluginConfig: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      runtime: {},
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: {
            hooks: { internal: { enabled: true } },
            plugins: {
              entries: {
                "memory-core": {
                  config: {
                    dreaming: {
                      enabled: true,
                      frequency: "15 4 * * *",
                      timezone: "UTC",
                    },
                  },
                },
              },
            },
          } as OpenClawConfig,
          deps: { cron: harness.cron },
        }),
      );

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.addCalls[0]).toMatchObject({
        schedule: {
          expr: "15 4 * * *",
          kind: "cron",
          tz: "UTC",
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("created managed dreaming cron job"),
      );
    } finally {
      clearInternalHooks();
    }
  });

  it("reconciles disabled->enabled config changes during runtime", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      logger,
      on: onMock,
      pluginConfig: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      runtime: {},
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      const deps = { cron: harness.cron };
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps,
        }),
      );

      expect(harness.addCalls).toHaveLength(0);

      api.config = {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "30 6 * * *",
                  timezone: "America/New_York",
                },
              },
            },
          },
        },
      } as OpenClawConfig;

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.addCalls[0]?.schedule).toMatchObject({
        expr: "30 6 * * *",
        kind: "cron",
        tz: "America/New_York",
      });
    } finally {
      clearInternalHooks();
    }
  });

  it("reconciles cadence/timezone updates against the active cron service after startup", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const startupHarness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 1 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      logger,
      on: onMock,
      pluginConfig: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      runtime: {},
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      const deps = { cron: startupHarness.cron };
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps,
        }),
      );

      expect(startupHarness.addCalls).toHaveLength(1);
      const managed = startupHarness.jobs.find((job) =>
        job.description?.includes("[managed-by=memory-core.short-term-promotion]"),
      );
      expect(managed).toBeDefined();

      const reloadedHarness = createCronHarness(
        managed
          ? [
              {
                ...managed,
                payload: managed.payload ? { ...managed.payload } : undefined,
                schedule: managed.schedule ? { ...managed.schedule } : undefined,
              },
            ]
          : [],
      );
      deps.cron = reloadedHarness.cron;
      api.config = {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "45 8 * * *",
                  timezone: "America/Los_Angeles",
                },
              },
            },
          },
        },
      } as OpenClawConfig;

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(startupHarness.updateCalls).toHaveLength(0);
      expect(reloadedHarness.updateCalls).toHaveLength(1);
      expect(reloadedHarness.updateCalls[0]?.patch.schedule).toMatchObject({
        expr: "45 8 * * *",
        kind: "cron",
        tz: "America/Los_Angeles",
      });
    } finally {
      clearInternalHooks();
    }
  });

  it("recreates the managed cron job when it is removed after startup", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      logger,
      on: onMock,
      pluginConfig: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      runtime: {},
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );
      expect(harness.addCalls).toHaveLength(1);

      harness.jobs.splice(
        0,
        harness.jobs.length,
        ...harness.jobs.filter(
          (job) => !job.description?.includes("[managed-by=memory-core.short-term-promotion]"),
        ),
      );
      expect(harness.jobs).toHaveLength(0);

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(harness.addCalls).toHaveLength(2);
      expect(harness.addCalls[1]?.schedule).toMatchObject({
        expr: "0 2 * * *",
        kind: "cron",
        tz: "UTC",
      });
    } finally {
      clearInternalHooks();
    }
  });

  it("does not reconcile managed cron on non-heartbeat runtime replies", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      logger,
      on: onMock,
      pluginConfig: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      runtime: {},
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );

      expect(harness.listCalls).toBe(1);

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply({ cleanedBody: "hello" }, { trigger: "user", workspaceDir: "." });
      await beforeAgentReply(
        { cleanedBody: "hello again" },
        { trigger: "user", workspaceDir: "." },
      );

      expect(harness.listCalls).toBe(1);
    } finally {
      clearInternalHooks();
    }
  });

  it("does not reconcile managed cron on every repeated runtime heartbeat", async () => {
    clearInternalHooks();
    const logger = createLogger();
    const harness = createCronHarness();
    const onMock = vi.fn();
    const now = Date.parse("2026-04-10T12:00:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const api: DreamingPluginApiTestDouble = {
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 2 * * *",
                  timezone: "UTC",
                },
              },
            },
          },
        },
      },
      logger,
      on: onMock,
      pluginConfig: {},
      registerHook: (event: string, handler: Parameters<typeof registerInternalHook>[1]) => {
        registerInternalHook(event, handler);
      },
      runtime: {},
    };

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerInternalHook(
        createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: api.config,
          deps: { cron: harness.cron },
        }),
      );

      expect(harness.listCalls).toBe(1);

      const beforeAgentReply = getBeforeAgentReplyHandler(onMock);
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );
      await beforeAgentReply(
        { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
        { trigger: "heartbeat", workspaceDir: "." },
      );

      expect(harness.listCalls).toBe(2);
    } finally {
      nowSpy.mockRestore();
      clearInternalHooks();
    }
  });
});

describe("short-term dreaming trigger", () => {
  it("applies promotions when the managed dreaming heartbeat event fires", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", ["Move backups to S3 Glacier."]);

    await recordShortTermRecalls({
      query: "backup policy",
      results: [
        {
          endLine: 1,
          path: "memory/2026-04-02.md",
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
          startLine: 1,
        },
      ],
      workspaceDir,
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: 10,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
      trigger: "heartbeat",
      workspaceDir,
    });

    expect(result?.handled).toBe(true);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(memoryText).toContain("Move backups to S3 Glacier.");
  });

  it("applies promotions when the managed dreaming token is embedded in a reminder body", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-composite-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", ["Move backups to S3 Glacier."]);

    await recordShortTermRecalls({
      query: "backup policy",
      results: [
        {
          endLine: 1,
          path: "memory/2026-04-02.md",
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
          startLine: 1,
        },
      ],
      workspaceDir,
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: [
        "System: rotate logs",
        "System: __openclaw_memory_core_short_term_promotion_dream__",
        "",
        "A scheduled reminder has been triggered. The reminder content is:",
        "",
        "rotate logs",
        "__openclaw_memory_core_short_term_promotion_dream__",
        "",
        "Handle this reminder internally. Do not relay it to the user unless explicitly requested.",
      ].join("\n"),
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: 10,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
      trigger: "heartbeat",
      workspaceDir,
    });

    expect(result?.handled).toBe(true);
    const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(memoryText).toContain("Move backups to S3 Glacier.");
  });

  it("keeps one-off recalls out of long-term memory under default thresholds", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-strict-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "Move backups to S3 Glacier.",
      "Retain quarterly snapshots.",
    ]);

    await recordShortTermRecalls({
      query: "glacier",
      results: [
        {
          endLine: 2,
          path: "memory/2026-04-03.md",
          score: 0.95,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
          startLine: 1,
        },
      ],
      workspaceDir,
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: constants.DEFAULT_DREAMING_LIMIT,
        minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
        minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
        minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
      trigger: "heartbeat",
      workspaceDir,
    });

    expect(result?.handled).toBe(true);
    const memoryText = await fs
      .readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return "";
        }
        throw error;
      });
    expect(memoryText).toBe("");
  });

  it("ignores non-heartbeat triggers", async () => {
    const logger = createLogger();
    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: 10,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
      trigger: "user",
      workspaceDir: "/tmp/workspace",
    });
    expect(result).toBeUndefined();
  });

  it("skips dreaming promotion cleanly when limit is zero", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-limit-zero-");

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: 0,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
      trigger: "heartbeat",
      workspaceDir,
    });

    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled by limit",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: dreaming promotion skipped because limit=0.",
    );
    await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("repairs recall artifacts before dreaming promotion runs", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-repair-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "Move backups to S3 Glacier and sync router failover notes.",
      "Keep router recovery docs current.",
    ]);
    const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              conceptTags: [],
              endLine: 2,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              key: "memory:memory/2026-04-03.md:1:2",
              lastRecalledAt: "2026-04-03T00:00:00.000Z",
              maxScore: 0.95,
              path: "memory/2026-04-03.md",
              queryHashes: ["abc", "abc", "def"],
              recallCount: 3,
              recallDays: ["2026-04-01", "2026-04-01", "2026-04-03"],
              snippet: "Move backups to S3 Glacier and sync router failover notes.",
              source: "memory",
              startLine: 1,
              totalScore: 2.7,
            },
          },
          updatedAt: "2026-04-01T00:00:00.000Z",
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: 10,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
      trigger: "heartbeat",
      workspaceDir,
    });

    expect(result?.handled).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("normalized recall artifacts before dreaming"),
    );
    const repaired = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      entries: Record<
        string,
        { queryHashes?: string[]; recallDays?: string[]; conceptTags?: string[] }
      >;
    };
    expect(repaired.entries["memory:memory/2026-04-03.md:1:2"]?.queryHashes).toEqual([
      "abc",
      "def",
    ]);
    expect(repaired.entries["memory:memory/2026-04-03.md:1:2"]?.recallDays).toEqual([
      "2026-04-01",
      "2026-04-03",
    ]);
    expect(repaired.entries["memory:memory/2026-04-03.md:1:2"]?.conceptTags).toEqual(
      expect.arrayContaining(["glacier", "router", "failover"]),
    );
  });

  it("emits detailed run logs when verboseLogging is enabled", async () => {
    const logger = createLogger();
    const workspaceDir = await createTempWorkspace("memory-dreaming-verbose-");
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", ["Move backups to S3 Glacier."]);

    await recordShortTermRecalls({
      query: "backup policy",
      results: [
        {
          endLine: 1,
          path: "memory/2026-04-02.md",
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
          startLine: 1,
        },
      ],
      workspaceDir,
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: 10,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: true,
      },
      logger,
      trigger: "heartbeat",
      workspaceDir,
    });

    expect(result?.handled).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("memory-core: dreaming verbose enabled"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("memory-core: dreaming candidate details"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("memory-core: dreaming applied details"),
    );
  });

  it("fans out one dreaming run across configured agent workspaces", async () => {
    const logger = createLogger();
    const workspaceRoot = await createTempWorkspace("memory-dreaming-multi-");
    const alphaWorkspace = path.join(workspaceRoot, "alpha");
    const betaWorkspace = path.join(workspaceRoot, "beta");

    await writeDailyMemoryNote(alphaWorkspace, "2026-04-02", ["Alpha backup note."]);
    await writeDailyMemoryNote(betaWorkspace, "2026-04-02", ["Beta router note."]);
    await recordShortTermRecalls({
      query: "alpha backup",
      results: [
        {
          endLine: 1,
          path: "memory/2026-04-02.md",
          score: 0.9,
          snippet: "Alpha backup note.",
          source: "memory",
          startLine: 1,
        },
      ],
      workspaceDir: alphaWorkspace,
    });
    await recordShortTermRecalls({
      query: "beta router",
      results: [
        {
          endLine: 1,
          path: "memory/2026-04-02.md",
          score: 0.9,
          snippet: "Beta router note.",
          source: "memory",
          startLine: 1,
        },
      ],
      workspaceDir: betaWorkspace,
    });

    const result = await runShortTermDreamingPromotionIfTriggered({
      cfg: {
        agents: {
          defaults: {
            memorySearch: {
              enabled: true,
            },
          },
          list: [
            {
              id: "alpha",
              workspace: alphaWorkspace,
            },
            {
              id: "beta",
              workspace: betaWorkspace,
            },
          ],
        },
      } as OpenClawConfig,
      cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT,
      config: {
        cron: constants.DEFAULT_DREAMING_CRON_EXPR,
        enabled: true,
        limit: 10,
        minRecallCount: 0,
        minScore: 0,
        minUniqueQueries: 0,
        recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
        verboseLogging: false,
      },
      logger,
      trigger: "heartbeat",
      workspaceDir: alphaWorkspace,
    });

    expect(result?.handled).toBe(true);
    expect(await fs.readFile(path.join(alphaWorkspace, "MEMORY.md"), "utf8")).toContain(
      "Alpha backup note.",
    );
    expect(await fs.readFile(path.join(betaWorkspace, "MEMORY.md"), "utf8")).toContain(
      "Beta router note.",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "memory-core: dreaming promotion complete (workspaces=2, candidates=2, applied=2, failed=0).",
    );
  });
});
