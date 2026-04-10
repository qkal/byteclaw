import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  DEFAULT_CRON_RUN_LOG_MAX_BYTES,
  appendCronRunLog,
  getPendingCronRunLogWriteCountForTests,
  readCronRunLogEntries,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "./run-log.js";

describe("cron run log", () => {
  it("resolves prune options from config with defaults", () => {
    expect(resolveCronRunLogPruneOptions()).toEqual({
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
    });
    expect(
      resolveCronRunLogPruneOptions({
        keepLines: 123,
        maxBytes: "5mb",
      }),
    ).toEqual({
      keepLines: 123,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(
      resolveCronRunLogPruneOptions({
        keepLines: -1,
        maxBytes: "invalid",
      }),
    ).toEqual({
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
    });
  });

  async function withRunLogDir(prefix: string, run: (dir: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(dir);
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  }

  it("resolves store path to per-job runs/<jobId>.jsonl", () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    const p = resolveCronRunLogPath({ jobId: "job-1", storePath });
    expect(p.endsWith(path.join(os.tmpdir(), "cron", "runs", "job-1.jsonl"))).toBe(true);
  });

  it("rejects unsafe job ids when resolving run log path", () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    expect(() => resolveCronRunLogPath({ jobId: "../job-1", storePath })).toThrow(
      /invalid cron run log job id/i,
    );
    expect(() => resolveCronRunLogPath({ jobId: "nested/job-1", storePath })).toThrow(
      /invalid cron run log job id/i,
    );
    expect(() => resolveCronRunLogPath({ jobId: "..\\job-1", storePath })).toThrow(
      /invalid cron run log job id/i,
    );
  });

  it("appends JSONL and prunes by line count", async () => {
    await withRunLogDir("openclaw-cron-log-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");

      for (let i = 0; i < 10; i++) {
        await appendCronRunLog(
          logPath,
          {
            action: "finished",
            durationMs: i,
            jobId: "job-1",
            status: "ok",
            ts: 1000 + i,
          },
          { keepLines: 3, maxBytes: 1 },
        );
      }

      const raw = await fs.readFile(logPath, "utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(lines.length).toBe(3);
      const last = JSON.parse(lines[2] ?? "{}") as { ts?: number };
      expect(last.ts).toBe(1009);
    });
  });

  it.skipIf(process.platform === "win32")(
    "writes run log files with secure permissions",
    async () => {
      await withRunLogDir("openclaw-cron-log-perms-", async (dir) => {
        const logPath = path.join(dir, "runs", "job-1.jsonl");

        await appendCronRunLog(logPath, {
          action: "finished",
          jobId: "job-1",
          status: "ok",
          ts: 1,
        });

        const mode = (await fs.stat(logPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "hardens an existing run-log directory to owner-only permissions",
    async () => {
      await withRunLogDir("openclaw-cron-log-dir-perms-", async (dir) => {
        const runDir = path.join(dir, "runs");
        const logPath = path.join(runDir, "job-1.jsonl");
        await fs.mkdir(runDir, { mode: 0o755, recursive: true });
        await fs.chmod(runDir, 0o755);

        await appendCronRunLog(logPath, {
          action: "finished",
          jobId: "job-1",
          status: "ok",
          ts: 1,
        });

        const runDirMode = (await fs.stat(runDir)).mode & 0o777;
        expect(runDirMode).toBe(0o700);
      });
    },
  );

  it("reads newest entries and filters by jobId", async () => {
    await withRunLogDir("openclaw-cron-log-read-", async (dir) => {
      const logPathA = path.join(dir, "runs", "a.jsonl");
      const logPathB = path.join(dir, "runs", "b.jsonl");

      await appendCronRunLog(logPathA, {
        action: "finished",
        jobId: "a",
        status: "ok",
        ts: 1,
      });
      await appendCronRunLog(logPathB, {
        action: "finished",
        error: "nope",
        jobId: "b",
        status: "error",
        summary: "oops",
        ts: 2,
      });
      await appendCronRunLog(logPathA, {
        action: "finished",
        jobId: "a",
        sessionId: "run-123",
        sessionKey: "agent:main:cron:a:run:run-123",
        status: "skipped",
        ts: 3,
      });

      const allA = await readCronRunLogEntries(logPathA, { limit: 10 });
      expect(allA.map((e) => e.jobId)).toEqual(["a", "a"]);

      const onlyA = await readCronRunLogEntries(logPathA, {
        jobId: "a",
        limit: 10,
      });
      expect(onlyA.map((e) => e.ts)).toEqual([1, 3]);

      const lastOne = await readCronRunLogEntries(logPathA, { limit: 1 });
      expect(lastOne.map((e) => e.ts)).toEqual([3]);
      expect(lastOne[0]?.sessionId).toBe("run-123");
      expect(lastOne[0]?.sessionKey).toBe("agent:main:cron:a:run:run-123");

      const onlyB = await readCronRunLogEntries(logPathB, {
        jobId: "b",
        limit: 10,
      });
      expect(onlyB[0]?.summary).toBe("oops");

      const wrongFilter = await readCronRunLogEntries(logPathA, {
        jobId: "b",
        limit: 10,
      });
      expect(wrongFilter).toEqual([]);
    });
  });

  it("ignores invalid and non-finished lines while preserving delivery fields", async () => {
    await withRunLogDir("openclaw-cron-log-filter-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        [
          '{"bad":',
          JSON.stringify({ action: "started", jobId: "job-1", status: "ok", ts: 1 }),
          JSON.stringify({
            action: "finished",
            delivered: true,
            deliveryError: "announce failed",
            deliveryStatus: "not-delivered",
            jobId: "job-1",
            status: "ok",
            ts: 2,
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const entries = await readCronRunLogEntries(logPath, { jobId: "job-1", limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(2);
      expect(entries[0]?.delivered).toBe(true);
      expect(entries[0]?.deliveryStatus).toBe("not-delivered");
      expect(entries[0]?.deliveryError).toBe("announce failed");
    });
  });

  it("reads telemetry fields", async () => {
    await withRunLogDir("openclaw-cron-log-telemetry-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");

      await appendCronRunLog(logPath, {
        action: "finished",
        jobId: "job-1",
        model: "gpt-5.4",
        provider: "openai",
        status: "ok",
        ts: 1,
        usage: {
          cache_read_tokens: 2,
          cache_write_tokens: 1,
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      });

      await fs.appendFile(
        logPath,
        `${JSON.stringify({
          action: "finished",
          jobId: "job-1",
          model: " ",
          provider: "",
          status: "ok",
          ts: 2,
          usage: { input_tokens: "oops" },
        })}\n`,
        "utf8",
      );

      const entries = await readCronRunLogEntries(logPath, { jobId: "job-1", limit: 10 });
      expect(entries[0]?.model).toBe("gpt-5.4");
      expect(entries[0]?.provider).toBe("openai");
      expect(entries[0]?.usage).toEqual({
        cache_read_tokens: 2,
        cache_write_tokens: 1,
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      });
      expect(entries[1]?.model).toBeUndefined();
      expect(entries[1]?.provider).toBeUndefined();
      expect(entries[1]?.usage?.input_tokens).toBeUndefined();
    });
  });

  it("cleans up pending-write bookkeeping after appends complete", async () => {
    await withRunLogDir("openclaw-cron-log-pending-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-cleanup.jsonl");
      await appendCronRunLog(logPath, {
        action: "finished",
        jobId: "job-cleanup",
        status: "ok",
        ts: 1,
      });

      expect(getPendingCronRunLogWriteCountForTests()).toBe(0);
    });
  });

  it("read drains pending fire-and-forget writes", async () => {
    await withRunLogDir("openclaw-cron-log-drain-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-drain.jsonl");

      // Fire-and-forget write (simulates the `void appendCronRunLog(...)` pattern
      // In server-cron.ts). Do NOT await.
      const writePromise = appendCronRunLog(logPath, {
        action: "finished",
        jobId: "job-drain",
        status: "ok",
        summary: "drain-test",
        ts: 42,
      });
      void writePromise.catch(() => undefined);

      // Read should see the entry because it drains pending writes.
      const entries = await readCronRunLogEntries(logPath, { limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(42);
      expect(entries[0]?.summary).toBe("drain-test");

      // Clean up
      await writePromise.catch(() => undefined);
    });
  });
});
