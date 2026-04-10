import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
} from "../config/sessions/store.js";
import { captureEnv } from "../test-utils/env.js";

const hoisted = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
  registryPath: undefined as string | undefined,
}));
const { announceSpy } = hoisted;
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

vi.mock("./subagent-registry.store.js", async () => {
  const actual = await vi.importActual<typeof import("./subagent-registry.store.js")>(
    "./subagent-registry.store.js",
  );
  const fsSync = await import("node:fs");
  const pathSync = await import("node:path");
  const resolvePath = () => hoisted.registryPath ?? actual.resolveSubagentRegistryPath();
  return {
    ...actual,
    loadSubagentRegistryFromDisk: () => {
      try {
        const parsed = JSON.parse(fsSync.readFileSync(resolvePath(), "utf8")) as {
          runs?: Record<string, import("./subagent-registry.types.js").SubagentRunRecord>;
        };
        return new Map(Object.entries(parsed.runs ?? {}));
      } catch {
        return new Map();
      }
    },
    resolveSubagentRegistryPath: resolvePath,
    saveSubagentRegistryToDisk: (
      runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>,
    ) => {
      const pathname = resolvePath();
      fsSync.mkdirSync(pathSync.dirname(pathname), { recursive: true });
      fsSync.writeFileSync(
        pathname,
        `${JSON.stringify({ runs: Object.fromEntries(runs), version: 2 }, null, 2)}\n`,
        "utf8",
      );
    },
  };
});

let mod: typeof import("./subagent-registry.js");
let callGatewayModule: typeof import("../gateway/call.js");
let agentEventsModule: typeof import("../infra/agent-events.js");

describe("subagent registry persistence resume", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const resolveSessionStorePath = (stateDir: string, agentId: string) =>
    path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

  const readSessionStore = async (storePath: string) => {
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      // Ignore
    }
    return {} as Record<string, Record<string, unknown>>;
  };

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const storePath = resolveSessionStorePath(tempStateDir, "main");
    const store = await readSessionStore(storePath);
    store[params.sessionKey] = {
      ...store[params.sessionKey],
      sessionId: params.sessionId ?? `sess-${Date.now()}`,
      updatedAt: params.updatedAt ?? Date.now(),
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, "utf8");
    return storePath;
  };

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
  };

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.js");
    callGatewayModule = await import("../gateway/call.js");
    agentEventsModule = await import("../infra/agent-events.js");
  });

  beforeEach(async () => {
    announceSpy.mockClear();
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(callGatewayModule.callGateway).mockReset();
    vi.mocked(callGatewayModule.callGateway).mockResolvedValue({
      endedAt: 222,
      startedAt: 111,
      status: "ok",
    });
    vi.mocked(agentEventsModule.onAgentEvent).mockReset();
    vi.mocked(agentEventsModule.onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    announceSpy.mockClear();
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    await drainSessionStoreLockQueuesForTest();
    clearSessionStoreCacheForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
      tempStateDir = null;
    }
    hoisted.registryPath = undefined;
    envSnapshot.restore();
  });

  it("persists runs to disk and resumes after restart", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    hoisted.registryPath = registryPath;

    let releaseInitialWait:
      | ((value: { status: "ok"; startedAt: number; endedAt: number }) => void)
      | undefined;
    vi.mocked(callGatewayModule.callGateway)
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            releaseInitialWait = resolve as typeof releaseInitialWait;
          }),
      )
      .mockResolvedValueOnce({
        endedAt: 222,
        startedAt: 111,
        status: "ok",
      });

    mod.registerSubagentRun({
      childSessionKey: "agent:main:subagent:test",
      cleanup: "keep",
      requesterDisplayKey: "main",
      requesterOrigin: { accountId: " acct-main ", channel: " whatsapp " },
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
      task: "do the thing",
    });
    await writeChildSessionEntry({
      sessionId: "sess-test",
      sessionKey: "agent:main:subagent:test",
    });

    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as { runs?: Record<string, unknown> };
    expect(parsed.runs && Object.keys(parsed.runs)).toContain("run-1");
    const run = parsed.runs?.["run-1"] as
      | {
          requesterOrigin?: { channel?: string; accountId?: string };
        }
      | undefined;
    expect(run).toBeDefined();
    if (run) {
      expect("requesterAccountId" in run).toBe(false);
      expect("requesterChannel" in run).toBe(false);
    }
    expect(run?.requesterOrigin?.channel).toBe("whatsapp");
    expect(run?.requesterOrigin?.accountId).toBe("acct-main");

    mod.resetSubagentRegistryForTests({ persist: false });
    mod.initSubagentRegistry();
    releaseInitialWait?.({
      endedAt: 222,
      startedAt: 111,
      status: "ok",
    });

    await flushQueuedRegistryWork();

    const announceCalls = announceSpy.mock.calls as unknown as [unknown][];
    const announce = (announceCalls.at(-1)?.[0] ?? undefined) as
      | {
          childRunId?: string;
          childSessionKey?: string;
          requesterSessionKey?: string;
          requesterOrigin?: { channel?: string; accountId?: string };
          task?: string;
          cleanup?: string;
          outcome?: { status?: string };
        }
      | undefined;
    if (announce) {
      expect(announce).toMatchObject({
        childRunId: "run-1",
        childSessionKey: "agent:main:subagent:test",
        cleanup: "keep",
        outcome: { status: "ok" },
        requesterOrigin: {
          accountId: "acct-main",
          channel: "whatsapp",
        },
        requesterSessionKey: "agent:main:main",
        task: "do the thing",
      });
    }

    const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(restored?.childSessionKey).toBe("agent:main:subagent:test");
    expect(restored?.requesterOrigin?.channel).toBe("whatsapp");
    expect(restored?.requesterOrigin?.accountId).toBe("acct-main");
  });
});
