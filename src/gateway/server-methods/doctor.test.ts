import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, _agentId: string) => "/tmp/openclaw"),
);
const resolveMemorySearchConfig = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, _agentId: string) => { enabled: boolean } | null>(() => ({
    enabled: true,
  })),
);
const getMemorySearchManager = vi.hoisted(() => vi.fn());
const previewGroundedRemMarkdown = vi.hoisted(() => vi.fn());
const writeBackfillDiaryEntries = vi.hoisted(() => vi.fn());
const removeBackfillDiaryEntries = vi.hoisted(() => vi.fn());
const removeGroundedShortTermCandidates = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
}));

vi.mock("../../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManager,
}));

vi.mock("./doctor.memory-core-runtime.js", () => ({
  previewGroundedRemMarkdown,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  writeBackfillDiaryEntries,
}));

import { doctorHandlers } from "./doctor.js";

const invokeDoctorMemoryStatus = async (
  respond: ReturnType<typeof vi.fn>,
  context?: { cron?: { list?: ReturnType<typeof vi.fn> } },
) => {
  const cronList = context?.cron?.list ?? vi.fn(async () => []);
  await doctorHandlers["doctor.memory.status"]({
    client: null,
    context: {
      cron: {
        list: cronList,
      },
    } as never,
    isWebchatConnect: () => false,
    params: {} as never,
    req: {} as never,
    respond: respond as never,
  });
};

const invokeDoctorMemoryDreamDiary = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.memory.dreamDiary"]({
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params: {} as never,
    req: {} as never,
    respond: respond as never,
  });
};

const invokeDoctorMemoryBackfillDreamDiary = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.memory.backfillDreamDiary"]({
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params: {} as never,
    req: {} as never,
    respond: respond as never,
  });
};

const invokeDoctorMemoryResetDreamDiary = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.memory.resetDreamDiary"]({
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params: {} as never,
    req: {} as never,
    respond: respond as never,
  });
};

const invokeDoctorMemoryResetGroundedShortTerm = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.memory.resetGroundedShortTerm"]({
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params: {} as never,
    req: {} as never,
    respond: respond as never,
  });
};

const expectEmbeddingErrorResponse = (respond: ReturnType<typeof vi.fn>, error: string) => {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      agentId: "main",
      embedding: {
        error,
        ok: false,
      },
    }),
    undefined,
  );
};

describe("doctor.memory.status", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    resolveMemorySearchConfig.mockReset().mockReturnValue({ enabled: true });
    getMemorySearchManager.mockReset();
    previewGroundedRemMarkdown.mockReset();
    writeBackfillDiaryEntries.mockReset();
    removeBackfillDiaryEntries.mockReset();
    removeGroundedShortTermCandidates.mockReset();
  });

  it("returns gateway embedding probe status for the default agent", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        close,
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        status: () => ({ provider: "gemini" }),
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expect(getMemorySearchManager).toHaveBeenCalledWith({
      agentId: "main",
      cfg: expect.any(Object),
      purpose: "status",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "main",
        dreaming: expect.objectContaining({
          enabled: false,
          phaseSignalCount: 0,
          phases: expect.objectContaining({
            deep: expect.objectContaining({
              managedCronPresent: false,
            }),
          }),
          promotedEntries: [],
          promotedToday: 0,
          promotedTotal: 0,
          shortTermCount: 0,
          shortTermEntries: [],
          signalEntries: [],
          totalSignalCount: 0,
        }),
        embedding: { ok: true },
        provider: "gemini",
      }),
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("returns unavailable when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValue({
      error: "memory search unavailable",
      manager: null,
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "memory search unavailable");
  });

  it("returns probe failure when manager probe throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        close,
        probeEmbeddingAvailability: vi.fn().mockRejectedValue(new Error("timeout")),
        status: () => ({ provider: "openai" }),
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "gateway memory probe failed: timeout");
    expect(close).toHaveBeenCalled();
  });

  it("includes dreaming counts and managed cron status when workspace data is available", async () => {
    const now = Date.parse("2026-04-05T00:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recentIso = "2026-04-04T23:45:00.000Z";
    const olderIso = "2026-04-02T10:00:00.000Z";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-status-"));
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    const mainStorePath = path.join(
      mainWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    const alphaStorePath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    const mainPhaseSignalPath = path.join(
      mainWorkspaceDir,
      "memory",
      ".dreams",
      "phase-signals.json",
    );
    const alphaPhaseSignalPath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "phase-signals.json",
    );
    await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
    await fs.mkdir(path.dirname(alphaStorePath), { recursive: true });
    await fs.writeFile(
      mainStorePath,
      `${JSON.stringify(
        {
          entries: {
            "memory:memory/2026-04-02.md:1:2": {
              dailyCount: 5,
              endLine: 2,
              path: "memory/2026-04-02.md",
              promotedAt: recentIso,
              recallCount: 9,
              snippet: "Use the Happy Together calendar for flights.",
              source: "memory",
              startLine: 1,
            },
            "memory:memory/2026-04-03.md:1:2": {
              dailyCount: 1,
              endLine: 2,
              lastRecalledAt: recentIso,
              path: "memory/2026-04-03.md",
              promotedAt: undefined,
              recallCount: 2,
              snippet: "Emma prefers shorter, lower-pressure check-ins.",
              source: "memory",
              startLine: 1,
            },
          },
          updatedAt: recentIso,
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      alphaStorePath,
      `${JSON.stringify(
        {
          entries: {
            "memory:memory/2026-04-01.md:1:2": {
              dailyCount: 4,
              endLine: 2,
              path: "memory/2026-04-01.md",
              promotedAt: olderIso,
              recallCount: 7,
              snippet: "Bunji lives in London.",
              source: "memory",
              startLine: 1,
            },
            "memory:memory/2026-04-04.md:1:2": {
              dailyCount: 3,
              endLine: 2,
              path: "memory/2026-04-04.md",
              promotedAt: recentIso,
              recallCount: 8,
              snippet: "Always book the covered valet option at Park & Greet BCN.",
              source: "memory",
              startLine: 1,
            },
          },
          updatedAt: recentIso,
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      mainPhaseSignalPath,
      `${JSON.stringify(
        {
          entries: {
            "memory:memory/2026-04-02.md:1:2": {
              lightHits: 9,
              remHits: 9,
            },
            "memory:memory/2026-04-03.md:1:2": {
              lightHits: 2,
              remHits: 3,
            },
          },
          updatedAt: recentIso,
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      alphaPhaseSignalPath,
      `${JSON.stringify(
        {
          entries: {
            "memory:memory/2026-04-01.md:1:2": {
              lightHits: 5,
              remHits: 5,
            },
          },
          updatedAt: recentIso,
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
          userTimezone: "America/Los_Angeles",
        },
        list: [
          { id: "main", workspace: mainWorkspaceDir },
          { id: "alpha", workspace: alphaWorkspaceDir },
        ],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                frequency: "0 */4 * * *",
                phases: {
                  deep: {
                    maxAgeDays: 30,
                    recencyHalfLifeDays: 21,
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig);
    resolveAgentWorkspaceDir.mockImplementation((cfg: OpenClawConfig, agentId: string) => {
      if (agentId === "alpha") {
        return alphaWorkspaceDir;
      }
      return mainWorkspaceDir;
    });

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        close,
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        status: () => ({ provider: "gemini", workspaceDir: mainWorkspaceDir }),
      },
    });

    const cronList = vi.fn(async () => [
      {
        description: "[managed-by=memory-core.short-term-promotion] test",
        enabled: true,
        name: "Memory Dreaming Promotion",
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: { nextRunAtMs: now + 60_000 },
      },
    ]);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryStatus(respond, { cron: { list: cronList } });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          dreaming: expect.objectContaining({
            dailySignalCount: 1,
            enabled: true,
            lightPhaseHitCount: 2,
            phaseSignalCount: 5,
            phases: expect.objectContaining({
              deep: expect.objectContaining({
                cron: "0 */4 * * *",
                recencyHalfLifeDays: 21,
                maxAgeDays: 30,
                managedCronPresent: true,
                nextRunAtMs: now + 60_000,
              }),
            }),
            promotedEntries: expect.arrayContaining([
              expect.objectContaining({
                path: "memory/2026-04-04.md",
                promotedAt: recentIso,
              }),
              expect.objectContaining({
                path: "memory/2026-04-02.md",
                promotedAt: recentIso,
              }),
              expect.objectContaining({
                path: "memory/2026-04-01.md",
                promotedAt: olderIso,
              }),
            ]),
            promotedToday: 2,
            promotedTotal: 3,
            recallSignalCount: 2,
            remPhaseHitCount: 3,
            shortTermCount: 1,
            shortTermEntries: [
              expect.objectContaining({
                path: "memory/2026-04-03.md",
                snippet: "Emma prefers shorter, lower-pressure check-ins.",
                totalSignalCount: 3,
                lightHits: 2,
                remHits: 3,
                phaseHitCount: 5,
              }),
            ],
            signalEntries: [
              expect.objectContaining({
                path: "memory/2026-04-03.md",
                totalSignalCount: 3,
              }),
            ],
            timezone: "America/Los_Angeles",
            totalSignalCount: 3,
          }),
          embedding: { ok: true },
          provider: "gemini",
        }),
        undefined,
      );
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await fs.rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("falls back to the manager workspace when no configured dreaming workspaces resolve", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-fallback-"));
    const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              path: "memory/2026-04-03.md",
              promotedAt: "2026-04-04T00:00:00.000Z",
              source: "memory",
            },
          },
          updatedAt: "2026-04-04T00:00:00.000Z",
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    resolveMemorySearchConfig.mockReturnValue(null);
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {},
            },
          },
        },
      },
    } as OpenClawConfig);

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        close,
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        status: () => ({ provider: "gemini", workspaceDir }),
      },
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryStatus(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          dreaming: expect.objectContaining({
            phases: expect.objectContaining({
              deep: expect.objectContaining({
                managedCronPresent: false,
              }),
            }),
            promotedTotal: 0,
            shortTermCount: 0,
          }),
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("reads dreaming config from the selected memory slot plugin", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
          "memos-local-openclaw-plugin": {
            config: {
              dreaming: {
                enabled: true,
                frequency: "0 */4 * * *",
              },
            },
          },
        },
        slots: {
          memory: "memos-local-openclaw-plugin",
        },
      },
    } as OpenClawConfig);

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        close,
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        status: () => ({ provider: "gemini" }),
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        dreaming: expect.objectContaining({
          enabled: true,
          phases: expect.objectContaining({
            deep: expect.objectContaining({
              cron: "0 */4 * * *",
            }),
          }),
        }),
      }),
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("merges workspace store errors when multiple workspace stores are unreadable", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-error-"));
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    const alphaStorePath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    await fs.mkdir(path.dirname(alphaStorePath), { recursive: true });
    await fs.writeFile(
      alphaStorePath,
      `${JSON.stringify(
        {
          entries: {},
          updatedAt: "2026-04-04T00:00:00.000Z",
          version: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(mainWorkspaceDir, "memory", ".dreams"), { recursive: true });

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
        list: [
          { id: "main", workspace: mainWorkspaceDir },
          { id: "alpha", workspace: alphaWorkspaceDir },
        ],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {},
            },
          },
        },
      },
    } as OpenClawConfig);
    resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "alpha" ? alphaWorkspaceDir : mainWorkspaceDir,
    );

    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      const targetPath =
        typeof target === "string"
          ? target
          : Buffer.isBuffer(target)
            ? target.toString("utf8")
            : target instanceof URL
              ? target.pathname
              : "";
      if (
        targetPath === path.join(mainWorkspaceDir, "memory", ".dreams", "short-term-recall.json") ||
        targetPath === alphaStorePath
      ) {
        const error = Object.assign(new Error("denied"), { code: "EACCES" });
        throw error;
      }
      return await vi
        .importActual<typeof import("node:fs/promises")>("node:fs/promises")
        .then((actual) => actual.readFile(target, options as never));
    });

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        close,
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        status: () => ({ provider: "gemini", workspaceDir: mainWorkspaceDir }),
      },
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryStatus(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          dreaming: expect.objectContaining({
            promotedTotal: 0,
            shortTermCount: 0,
            storeError: "2 dreaming stores had read errors.",
          }),
        }),
        undefined,
      );
    } finally {
      readFileSpy.mockRestore();
      await fs.rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});

describe("doctor.memory dream actions", () => {
  it("clears grounded-only staged short-term entries without touching the diary", async () => {
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw");
    removeGroundedShortTermCandidates.mockResolvedValue({
      removed: 3,
      storePath: "/tmp/openclaw/memory/.dreams/short-term-recall.json",
    });
    const respond = vi.fn();

    await invokeDoctorMemoryResetGroundedShortTerm(respond);

    expect(removeGroundedShortTermCandidates).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        action: "resetGroundedShortTerm",
        agentId: "main",
        removedShortTermEntries: 3,
      },
      undefined,
    );
  });
});

describe("doctor.memory.dreamDiary", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    previewGroundedRemMarkdown.mockReset();
    writeBackfillDiaryEntries.mockReset();
    removeBackfillDiaryEntries.mockReset();
  });

  it("reads DREAMS.md when present", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-upper-"));
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(diaryPath, "## Dream Diary\n- staged durable memory\n", "utf8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryDreamDiary(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          content: "## Dream Diary\n- staged durable memory\n",
          found: true,
          path: "DREAMS.md",
          updatedAtMs: expect.any(Number),
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("reads lowercase dreams.md when present", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-lower-"));
    await fs.writeFile(path.join(workspaceDir, "dreams.md"), "lowercase diary\n", "utf8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryDreamDiary(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          content: "lowercase diary\n",
          found: true,
          updatedAtMs: expect.any(Number),
        }),
        undefined,
      );
      const payload = respond.mock.calls[0]?.[1] as { path?: unknown };
      expect(["DREAMS.md", "dreams.md"]).toContain(payload.path);
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("returns not-found payload when no dream diary exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-missing-"));
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryDreamDiary(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          found: false,
          path: "DREAMS.md",
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("backfills the dream diary from workspace memory files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-backfill-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-02-19.md"), "source\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n", "utf8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    previewGroundedRemMarkdown.mockResolvedValue({
      files: [
        {
          path: path.join(workspaceDir, "memory", "2026-02-19.md"),
          renderedMarkdown: "What Happened\n1. Bunji — partner\n",
        },
      ],
      scannedFiles: 1,
    });
    writeBackfillDiaryEntries.mockResolvedValue({
      dreamsPath: path.join(workspaceDir, "DREAMS.md"),
      replaced: 1,
      written: 1,
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryBackfillDreamDiary(respond);
      expect(previewGroundedRemMarkdown).toHaveBeenCalledWith({
        inputPaths: [path.join(workspaceDir, "memory", "2026-02-19.md")],
        workspaceDir,
      });
      expect(writeBackfillDiaryEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              bodyLines: expect.arrayContaining(["What Happened", "1. Bunji — partner"]),
            }),
          ],
        }),
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          action: "backfill",
          agentId: "main",
          replaced: 1,
          scannedFiles: 1,
          written: 1,
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("no-ops backfill when the workspace has no daily memory files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-empty-"));
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryBackfillDreamDiary(respond);
      expect(previewGroundedRemMarkdown).not.toHaveBeenCalled();
      expect(writeBackfillDiaryEntries).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          action: "backfill",
          agentId: "main",
          replaced: 0,
          scannedFiles: 0,
          written: 0,
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("resets only backfilled dream diary entries", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-reset-"));
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n", "utf8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    removeBackfillDiaryEntries.mockResolvedValue({
      dreamsPath: path.join(workspaceDir, "DREAMS.md"),
      removed: 3,
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryResetDreamDiary(respond);
      expect(removeBackfillDiaryEntries).toHaveBeenCalledWith({ workspaceDir });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          action: "reset",
          agentId: "main",
          removedEntries: 3,
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });
});
