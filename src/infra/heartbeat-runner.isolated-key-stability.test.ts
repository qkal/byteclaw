import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – isolated session key stability (#59493)", () => {
  /**
   * Simulates the wake-request feedback loop:
   *   1. Normal heartbeat tick produces sessionKey "agent:main:main:heartbeat"
   *   2. An exec/subagent event during that tick calls requestHeartbeatNow()
   *      with the already-suffixed key "agent:main:main:heartbeat"
   *   3. The wake handler passes that key back into runHeartbeatOnce(sessionKey: ...)
   *
   * Before the fix, step 3 would append another ":heartbeat" producing
   * "agent:main:main:heartbeat:heartbeat". After the fix, the key remains
   * stable at "agent:main:main:heartbeat".
   */
  async function runIsolatedHeartbeat(params: {
    tmpDir: string;
    storePath: string;
    cfg: OpenClawConfig;
    sessionKey: string;
  }) {
    await seedSessionStore(params.storePath, params.sessionKey, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "+1555",
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

    await runHeartbeatOnce({
      cfg: params.cfg,
      deps: {
        getQueueSize: () => 0,
        nowMs: () => 0,
      },
      sessionKey: params.sessionKey,
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    return replySpy.mock.calls[0]?.[0];
  }

  function makeIsolatedHeartbeatConfig(tmpDir: string, storePath: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          heartbeat: {
            every: "5m",
            isolatedSession: true,
            target: "whatsapp",
          },
          workspace: tmpDir,
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
  }

  function makeNamedIsolatedHeartbeatConfig(
    tmpDir: string,
    storePath: string,
    heartbeatSession: string,
  ): OpenClawConfig {
    return {
      agents: {
        defaults: {
          heartbeat: {
            every: "5m",
            isolatedSession: true,
            session: heartbeatSession,
            target: "whatsapp",
          },
          workspace: tmpDir,
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
  }

  it("does not accumulate :heartbeat suffix when wake passes an already-suffixed key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      // Simulate wake-request path: key already has :heartbeat from a previous tick.
      const alreadySuffixedKey = `${baseSessionKey}:heartbeat`;
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [alreadySuffixedKey]: {
            heartbeatIsolatedBaseSessionKey: baseSessionKey,
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            sessionId: "sid",
            updatedAt: 1,
          },
        }),
        "utf8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
        sessionKey: alreadySuffixedKey,
      });

      // Key must remain stable — no double :heartbeat suffix.
      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("appends :heartbeat exactly once from a clean base key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      const ctx = await runIsolatedHeartbeat({
        cfg,
        sessionKey: baseSessionKey,
        storePath,
        tmpDir,
      });

      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("stays stable even with multiply-accumulated suffixes", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      // Simulate a key that already accumulated several :heartbeat suffixes
      // (from an unpatched gateway running for many ticks).
      const deeplyAccumulatedKey = `${baseSessionKey}:heartbeat:heartbeat:heartbeat`;

      const ctx = await runIsolatedHeartbeat({
        cfg,
        sessionKey: deeplyAccumulatedKey,
        storePath,
        tmpDir,
      });

      // After the fix, ALL trailing :heartbeat suffixes are stripped by the
      // (:heartbeat)+$ regex in a single pass, then exactly one is re-appended.
      // A deeply accumulated key converges to "<base>:heartbeat" in one call.
      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);

      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
        string,
        { heartbeatIsolatedBaseSessionKey?: string }
      >;
      expect(store[deeplyAccumulatedKey]).toBeUndefined();
      expect(store[`${baseSessionKey}:heartbeat`]).toMatchObject({
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
    });
  });

  it("keeps isolated keys distinct when the configured base key already ends with :heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeNamedIsolatedHeartbeatConfig(tmpDir, storePath, "alerts:heartbeat");
      const baseSessionKey = "agent:main:alerts:heartbeat";

      const ctx = await runIsolatedHeartbeat({
        cfg,
        sessionKey: baseSessionKey,
        storePath,
        tmpDir,
      });

      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("stays stable for wake re-entry when the configured base key already ends with :heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeNamedIsolatedHeartbeatConfig(tmpDir, storePath, "alerts:heartbeat");
      const baseSessionKey = "agent:main:alerts:heartbeat";
      const alreadyIsolatedKey = `${baseSessionKey}:heartbeat`;
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [alreadyIsolatedKey]: {
            heartbeatIsolatedBaseSessionKey: baseSessionKey,
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            sessionId: "sid",
            updatedAt: 1,
          },
        }),
        "utf8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
        sessionKey: alreadyIsolatedKey,
      });

      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(alreadyIsolatedKey);
    });
  });

  it("keeps a forced real :heartbeat session distinct from the heartbeat-isolated sibling", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const realSessionKey = "agent:main:alerts:heartbeat";

      const ctx = await runIsolatedHeartbeat({
        cfg,
        sessionKey: realSessionKey,
        storePath,
        tmpDir,
      });

      expect(ctx?.SessionKey).toBe(`${realSessionKey}:heartbeat`);
    });
  });

  it("stays stable when a forced real :heartbeat session re-enters through its isolated sibling", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const realSessionKey = "agent:main:alerts:heartbeat";
      const isolatedSessionKey = `${realSessionKey}:heartbeat`;

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [isolatedSessionKey]: {
            heartbeatIsolatedBaseSessionKey: realSessionKey,
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            sessionId: "sid",
            updatedAt: 1,
          },
        }),
        "utf8",
      );

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
        sessionKey: isolatedSessionKey,
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(isolatedSessionKey);
    });
  });

  it("does not create an isolated session when task-based heartbeat skips for no-tasks-due", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: {
              isolatedSession: true,
              target: "whatsapp",
            },
            workspace: tmpDir,
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      await fs.writeFile(
        `${tmpDir}/HEARTBEAT.md`,
        `tasks:
  - name: daily-check
    interval: 1d
    prompt: "Check status"
`,
        "utf8",
      );

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [baseSessionKey]: {
            heartbeatTaskState: {
              "daily-check": 1,
            },
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            sessionId: "sid",
            updatedAt: 1,
          },
        }),
        "utf8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 2,
        },
        sessionKey: baseSessionKey,
      });

      expect(result).toEqual({ reason: "no-tasks-due", status: "skipped" });
      expect(replySpy).not.toHaveBeenCalled();

      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
      expect(store[isolatedSessionKey]).toBeUndefined();
    });
  });

  it("converges a legacy isolated key that lacks the stored marker (single :heartbeat suffix)", async () => {
    // Regression for: when an isolated session was created before
    // HeartbeatIsolatedBaseSessionKey was introduced, sessionKey already equals
    // "<base>:heartbeat" but the stored entry has no marker. The fallback used to
    // Treat "<base>:heartbeat" as the new base and persist it as the marker, so
    // The next wake re-entry would stabilise at "<base>:heartbeat:heartbeat"
    // Instead of converging back to "<base>:heartbeat".
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const legacyIsolatedKey = `${baseSessionKey}:heartbeat`;

      // Legacy entry: has :heartbeat suffix but no heartbeatIsolatedBaseSessionKey marker.
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [legacyIsolatedKey]: {
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            sessionId: "sid",
            updatedAt: 1,
          },
        }),
        "utf8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
        sessionKey: legacyIsolatedKey,
      });

      // Must converge to the same canonical isolated key, not produce :heartbeat:heartbeat.
      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(legacyIsolatedKey);
    });
  });
});
