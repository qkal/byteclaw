import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { GatewayLockError, type GatewayLockOptions, acquireGatewayLock } from "./gateway-lock.js";

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-lock-" });
let fixtureRoot = "";
const realNow = Date.now.bind(Date);

function resolveTestLockDir() {
  return path.join(fixtureRoot, "__locks");
}

async function makeEnv() {
  const dir = await fixtureRootTracker.make("case");
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  return {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: dir,
  };
}

async function acquireForTest(
  env: NodeJS.ProcessEnv,
  opts: Omit<GatewayLockOptions, "env" | "allowInTests"> = {},
) {
  return await acquireGatewayLock({
    allowInTests: true,
    env,
    lockDir: resolveTestLockDir(),
    now: realNow,
    pollIntervalMs: 2,
    sleep: async (ms) => {
      await nativeSleep(ms);
    },
    timeoutMs: 30,
    ...opts,
  });
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const lockDir = resolveTestLockDir();
  return { configPath, lockPath: path.join(lockDir, `gateway.${hash}.lock`) };
}

function makeProcStat(pid: number, startTime: number) {
  const fields = [
    "R",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    String(startTime),
    "1",
    "1",
  ];
  return `${pid} (node) ${fields.join(" ")}`;
}

function createLockPayload(params: { configPath: string; startTime: number; createdAt?: string }) {
  return {
    configPath: params.configPath,
    createdAt: params.createdAt ?? new Date().toISOString(),
    pid: process.pid,
    startTime: params.startTime,
  };
}

function mockProcStatRead(params: { onProcRead: () => string }) {
  const { readFileSync } = fsSync;
  return vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
    if (filePath === `/proc/${process.pid}/stat`) {
      return params.onProcRead();
    }
    return readFileSync(filePath as never, encoding as never) as never;
  });
}

async function writeLockFile(
  env: NodeJS.ProcessEnv,
  params: { startTime: number; createdAt?: string } = { startTime: 111 },
) {
  const { lockPath, configPath } = resolveLockPath(env);
  const payload = createLockPayload({
    configPath,
    createdAt: params.createdAt,
    startTime: params.startTime,
  });
  await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");
  return { configPath, lockPath };
}

function createEaccesProcStatSpy() {
  return mockProcStatRead({
    onProcRead: () => {
      throw new Error("EACCES");
    },
  });
}

function createPortProbeConnectionSpy(result: "connect" | "refused") {
  return vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = vi.fn();
    setImmediate(() => {
      if (result === "connect") {
        socket.emit("connect");
        return;
      }
      socket.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    });
    return socket;
  });
}

async function writeRecentLockFile(env: NodeJS.ProcessEnv, startTime = 111) {
  await writeLockFile(env, {
    createdAt: new Date().toISOString(),
    startTime,
  });
}

describe("gateway lock", () => {
  beforeAll(async () => {
    fixtureRoot = await fixtureRootTracker.setup();
  });

  beforeEach(() => {
    // Other suites occasionally leave global spies behind (Date.now, setTimeout, etc.).
    // This test relies on fake timers advancing Date.now and setTimeout deterministically.
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
    fixtureRoot = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("blocks concurrent acquisition until release", async () => {
    // Fake timers can hang on Windows CI when combined with fs open loops.
    // Keep this test on real timers and use small timeouts.
    vi.useRealTimers();
    const env = await makeEnv();
    const lock = await acquireForTest(env, { timeoutMs: 50 });
    expect(lock).not.toBeNull();

    const pending = acquireForTest(env, {
      readProcessCmdline: () => ["openclaw", "gateway", "run"],
      timeoutMs: 15,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    await lock?.release();
    const lock2 = await acquireForTest(env);
    await lock2?.release();
  });

  it("treats recycled linux pid as stale when start time mismatches", async () => {
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = createLockPayload({ configPath, startTime: 111 });
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const statValue = makeProcStat(process.pid, 222);
    const spy = mockProcStatRead({
      onProcRead: () => statValue,
    });

    const lock = await acquireForTest(env, {
      platform: "linux",
      pollIntervalMs: 5,
      timeoutMs: 80,
    });
    expect(lock).not.toBeNull();

    await lock?.release();
    spy.mockRestore();
  });

  it("keeps lock on linux when proc access fails unless stale", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeLockFile(env);
    const spy = createEaccesProcStatSpy();

    const pending = acquireForTest(env, {
      platform: "linux",
      staleMs: 10_000,
      timeoutMs: 15,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    spy.mockRestore();
  });

  it("keeps lock when fs.stat fails until payload is stale", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeLockFile(env);
    const procSpy = createEaccesProcStatSpy();
    const statSpy = vi
      .spyOn(fs, "stat")
      .mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));

    const pending = acquireForTest(env, {
      platform: "linux",
      staleMs: 10_000,
      timeoutMs: 20,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    procSpy.mockRestore();
    statSpy.mockRestore();
  });

  it("treats lock as stale when owner pid is alive but configured port is free", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);
    const connectSpy = createPortProbeConnectionSpy("refused");

    const lock = await acquireForTest(env, {
      platform: "darwin",
      pollIntervalMs: 5,
      port: 18_789,
      staleMs: 10_000,
      timeoutMs: 80,
    });
    expect(lock).not.toBeNull();
    await lock?.release();
    connectSpy.mockRestore();
  });

  it("keeps lock when configured port is busy and owner pid is alive", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);
    const connectSpy = createPortProbeConnectionSpy("connect");
    try {
      const pending = acquireForTest(env, {
        platform: "darwin",
        pollIntervalMs: 2,
        port: 18_789,
        readProcessCmdline: () => ["/usr/local/bin/openclaw", "gateway", "run"],
        staleMs: 10_000,
        timeoutMs: 20,
      });
      await expect(pending).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("returns null when multi-gateway override is enabled", async () => {
    const env = await makeEnv();
    const lock = await acquireGatewayLock({
      env: { ...env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1", VITEST: "" },
      lockDir: resolveTestLockDir(),
    });
    expect(lock).toBeNull();
  });

  it("returns null in test env unless allowInTests is set", async () => {
    const env = await makeEnv();
    const lock = await acquireGatewayLock({
      env: { ...env, VITEST: "1" },
      lockDir: resolveTestLockDir(),
    });
    expect(lock).toBeNull();
  });

  it("wraps unexpected fs errors as GatewayLockError", async () => {
    const env = await makeEnv();
    const openSpy = vi.spyOn(fs, "open").mockRejectedValueOnce(
      Object.assign(new Error("denied"), {
        code: "EACCES",
      }),
    );

    await expect(acquireForTest(env)).rejects.toBeInstanceOf(GatewayLockError);
    openSpy.mockRestore();
  });

  it("clears stale lock on win32 when process cmdline is not a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const lock = await acquireForTest(env, {
      platform: "win32",
      pollIntervalMs: 5,
      port: 18_789,
      readProcessCmdline: () => ["chrome.exe", "--no-sandbox"],
      staleMs: 10_000,
      timeoutMs: 80,
    });
    expect(lock).not.toBeNull();
    await lock?.release();

    connectSpy.mockRestore();
  });

  it("keeps lock on win32 when process cmdline is a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const pending = acquireForTest(env, {
      platform: "win32",
      pollIntervalMs: 2,
      port: 18_789,
      readProcessCmdline: () => [
        String.raw`C:\Users\me\AppData\Roaming\npm\openclaw.cmd`,
        "gateway",
        "run",
      ],
      staleMs: 10_000,
      timeoutMs: 20,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    connectSpy.mockRestore();
  });

  it("falls back to unknown on win32 when cmdline reader returns null", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const pending = acquireForTest(env, {
      platform: "win32",
      pollIntervalMs: 2,
      port: 18_789,
      readProcessCmdline: () => null,
      staleMs: 10_000,
      timeoutMs: 20,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    connectSpy.mockRestore();
  });

  it("clears stale lock on darwin when process cmdline is not a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const lock = await acquireForTest(env, {
      platform: "darwin",
      pollIntervalMs: 5,
      port: 18_789,
      readProcessCmdline: () => ["/Applications/Safari.app/Contents/MacOS/Safari"],
      staleMs: 10_000,
      timeoutMs: 80,
    });
    expect(lock).not.toBeNull();
    await lock?.release();

    connectSpy.mockRestore();
  });

  it("keeps lock on darwin when process cmdline is a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const pending = acquireForTest(env, {
      platform: "darwin",
      pollIntervalMs: 2,
      port: 18_789,
      readProcessCmdline: () => ["/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"],
      staleMs: 10_000,
      timeoutMs: 20,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    connectSpy.mockRestore();
  });
});
