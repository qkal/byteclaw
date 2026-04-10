import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  resolveConfigAuditLogPath,
} from "./io.audit.js";

function createRenameAuditRecord(home: string) {
  return finalizeConfigWriteAuditRecord({
    base: createConfigWriteAuditRecordBase({
      changedPathCount: 1,
      configPath: path.join(home, ".openclaw", "openclaw.json"),
      env: {} as NodeJS.ProcessEnv,
      existsBefore: true,
      gatewayModeAfter: "local",
      gatewayModeBefore: "local",
      hasMetaAfter: true,
      hasMetaBefore: true,
      nextBytes: 24,
      nextHash: "next-hash",
      now: "2026-04-07T08:00:00.000Z",
      previousBytes: 12,
      previousHash: "prev-hash",
      previousMetadata: {
        dev: "10",
        gid: 20,
        ino: "11",
        mode: 0o600,
        nlink: 1,
        uid: 501,
      },
      suspicious: [],
    }),
    nextMetadata: {
      dev: "12",
      gid: 20,
      ino: "13",
      mode: 0o600,
      nlink: 1,
      uid: 501,
    },
    result: "rename",
  });
}

function readAuditLog(home: string): unknown[] {
  const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
  return fs
    .readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("config io audit helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-audit-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it('ignores literal "undefined" home env values when choosing the audit log path', async () => {
    const home = await suiteRootTracker.make("home");
    const auditPath = resolveConfigAuditLogPath(
      {
        HOME: "undefined",
        OPENCLAW_HOME: "undefined",
        USERPROFILE: "null",
      } as NodeJS.ProcessEnv,
      () => home,
    );
    expect(auditPath).toBe(path.join(home, ".openclaw", "logs", "config-audit.jsonl"));
    expect(auditPath.startsWith(path.resolve("undefined"))).toBe(false);
  });

  it("formats overwrite warnings with hash transition and backup path", () => {
    expect(
      formatConfigOverwriteLogMessage({
        changedPathCount: 3,
        configPath: "/tmp/openclaw.json",
        nextHash: "next-hash",
        previousHash: "prev-hash",
      }),
    ).toBe(
      "Config overwrite: /tmp/openclaw.json (sha256 prev-hash -> next-hash, backup=/tmp/openclaw.json.bak, changedPaths=3)",
    );
  });

  it("captures watch markers and next stat metadata for successful writes", () => {
    const base = createConfigWriteAuditRecordBase({
      changedPathCount: 2,
      configPath: "/tmp/openclaw.json",
      env: {
        OPENCLAW_WATCH_COMMAND: "gateway --force",
        OPENCLAW_WATCH_MODE: "1",
        OPENCLAW_WATCH_SESSION: "watch-session-1",
      } as NodeJS.ProcessEnv,
      existsBefore: true,
      gatewayModeAfter: "local",
      gatewayModeBefore: null,
      hasMetaAfter: true,
      hasMetaBefore: false,
      nextBytes: 24,
      nextHash: "next-hash",
      now: "2026-04-07T08:00:00.000Z",
      previousBytes: 12,
      previousHash: "prev-hash",
      previousMetadata: {
        dev: "10",
        gid: 20,
        ino: "11",
        mode: 0o600,
        nlink: 1,
        uid: 501,
      },
      processInfo: {
        argv: ["node", "openclaw"],
        cwd: "/work",
        execArgv: ["--loader"],
        pid: 101,
        ppid: 99,
      },
      suspicious: ["missing-meta-before-write"],
    });
    const record = finalizeConfigWriteAuditRecord({
      base,
      nextMetadata: {
        dev: "12",
        gid: 20,
        ino: "13",
        mode: 0o600,
        nlink: 1,
        uid: 501,
      },
      result: "rename",
    });

    expect(record.watchMode).toBe(true);
    expect(record.watchSession).toBe("watch-session-1");
    expect(record.watchCommand).toBe("gateway --force");
    expect(record.nextHash).toBe("next-hash");
    expect(record.nextBytes).toBe(24);
    expect(record.nextDev).toBe("12");
    expect(record.nextIno).toBe("13");
    expect(record.result).toBe("rename");
  });

  it("drops next-file metadata and preserves error details for failed writes", () => {
    const base = createConfigWriteAuditRecordBase({
      changedPathCount: 1,
      configPath: "/tmp/openclaw.json",
      env: {} as NodeJS.ProcessEnv,
      existsBefore: true,
      gatewayModeAfter: "local",
      gatewayModeBefore: "local",
      hasMetaAfter: true,
      hasMetaBefore: true,
      nextBytes: 24,
      nextHash: "next-hash",
      now: "2026-04-07T08:00:00.000Z",
      previousBytes: 12,
      previousHash: "prev-hash",
      previousMetadata: {
        dev: "10",
        gid: 20,
        ino: "11",
        mode: 0o600,
        nlink: 1,
        uid: 501,
      },
      suspicious: [],
    });
    const err = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const record = finalizeConfigWriteAuditRecord({
      base,
      err,
      result: "failed",
    });

    expect(record.result).toBe("failed");
    expect(record.nextHash).toBeNull();
    expect(record.nextBytes).toBeNull();
    expect(record.nextDev).toBeNull();
    expect(record.errorCode).toBe("ENOSPC");
    expect(record.errorMessage).toBe("disk full");
  });

  it("appends JSONL audit entries to the resolved audit path", async () => {
    const home = await suiteRootTracker.make("append");
    const record = createRenameAuditRecord(home);

    await appendConfigAuditRecord({
      env: {} as NodeJS.ProcessEnv,
      fs,
      homedir: () => home,
      record,
    });

    const records = readAuditLog(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "config.write",
      nextHash: "next-hash",
      result: "rename",
    });
  });

  it("also accepts flattened audit record params from legacy call sites", async () => {
    const home = await suiteRootTracker.make("append-flat");
    const record = createRenameAuditRecord(home);

    await appendConfigAuditRecord({
      env: {} as NodeJS.ProcessEnv,
      fs,
      homedir: () => home,
      ...record,
    });

    const records = readAuditLog(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "config.write",
      nextHash: "next-hash",
      result: "rename",
    });
  });
});
