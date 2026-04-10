import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  clearApnsRegistration,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  registerApnsRegistration,
  registerApnsToken,
} from "./push-apns.js";

const tempDirs = createTrackedTempDirs();

async function makeTempDir(): Promise<string> {
  return await tempDirs.make("openclaw-push-apns-store-test-");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("push APNs registration store", () => {
  it("stores and reloads direct APNs registrations", async () => {
    const baseDir = await makeTempDir();
    const saved = await registerApnsToken({
      baseDir,
      environment: "sandbox",
      nodeId: "ios-node-1",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
    });

    const loaded = await loadApnsRegistration("ios-node-1", baseDir);
    expect(loaded).toMatchObject({
      environment: "sandbox",
      nodeId: "ios-node-1",
      topic: "ai.openclaw.ios",
      transport: "direct",
      updatedAtMs: saved.updatedAtMs,
    });
    expect(loaded && loaded.transport === "direct" ? loaded.token : null).toBe(
      "abcd1234abcd1234abcd1234abcd1234",
    );
  });

  it("stores relay-backed registrations without a raw token", async () => {
    const baseDir = await makeTempDir();
    const saved = await registerApnsRegistration({
      baseDir,
      distribution: "official",
      environment: "production",
      installationId: "install-123",
      nodeId: "ios-node-relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      tokenDebugSuffix: " abcd-1234 ",
      topic: "ai.openclaw.ios",
      transport: "relay",
    });

    const loaded = await loadApnsRegistration("ios-node-relay", baseDir);
    expect(saved.transport).toBe("relay");
    expect(loaded).toMatchObject({
      distribution: "official",
      environment: "production",
      installationId: "install-123",
      nodeId: "ios-node-relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      tokenDebugSuffix: "abcd1234",
      topic: "ai.openclaw.ios",
      transport: "relay",
    });
    expect(loaded && "token" in loaded).toBe(false);
  });

  it("normalizes legacy direct records from disk and ignores invalid entries", async () => {
    const baseDir = await makeTempDir();
    const statePath = path.join(baseDir, "push", "apns-registrations.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          registrationsByNodeId: {
            "   ": {
              nodeId: " ios-node-fallback ",
              token: "<ABCD1234ABCD1234ABCD1234ABCD1234>",
              topic: " ai.openclaw.ios ",
              updatedAtMs: 2,
            },
            " ios-node-legacy ": {
              environment: " PRODUCTION ",
              nodeId: " ios-node-legacy ",
              token: "<ABCD1234ABCD1234ABCD1234ABCD1234>",
              topic: " ai.openclaw.ios ",
              updatedAtMs: 3,
            },
            "ios-node-bad-relay": {
              distribution: "beta",
              environment: "production",
              installationId: "install-123",
              nodeId: "ios-node-bad-relay",
              relayHandle: "relay-handle-123",
              sendGrant: "send-grant-123",
              topic: "ai.openclaw.ios",
              transport: "relay",
              updatedAtMs: 1,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(loadApnsRegistration("ios-node-legacy", baseDir)).resolves.toMatchObject({
      environment: "production",
      nodeId: "ios-node-legacy",
      token: "abcd1234abcd1234abcd1234abcd1234",
      topic: "ai.openclaw.ios",
      transport: "direct",
      updatedAtMs: 3,
    });
    await expect(loadApnsRegistration("ios-node-fallback", baseDir)).resolves.toMatchObject({
      environment: "sandbox",
      nodeId: "ios-node-fallback",
      topic: "ai.openclaw.ios",
      transport: "direct",
      updatedAtMs: 2,
    });
    await expect(loadApnsRegistration("ios-node-bad-relay", baseDir)).resolves.toBeNull();
  });

  it("falls back cleanly for malformed or missing registration state", async () => {
    const baseDir = await makeTempDir();
    const statePath = path.join(baseDir, "push", "apns-registrations.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "[]", "utf8");

    await expect(loadApnsRegistration("ios-node-missing", baseDir)).resolves.toBeNull();
    await expect(loadApnsRegistration("   ", baseDir)).resolves.toBeNull();
    await expect(clearApnsRegistration("   ", baseDir)).resolves.toBe(false);
    await expect(clearApnsRegistration("ios-node-missing", baseDir)).resolves.toBe(false);
  });

  it("rejects invalid direct and relay registration inputs", async () => {
    const baseDir = await makeTempDir();
    const oversized = "x".repeat(257);

    await expect(
      registerApnsToken({
        baseDir,
        nodeId: "ios-node-1",
        token: "not-a-token",
        topic: "ai.openclaw.ios",
      }),
    ).rejects.toThrow("invalid APNs token");
    await expect(
      registerApnsToken({
        baseDir,
        nodeId: "n".repeat(257),
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
      }),
    ).rejects.toThrow("nodeId required");
    await expect(
      registerApnsToken({
        baseDir,
        nodeId: "ios-node-1",
        token: "A".repeat(513),
        topic: "ai.openclaw.ios",
      }),
    ).rejects.toThrow("invalid APNs token");
    await expect(
      registerApnsToken({
        baseDir,
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "a".repeat(256),
      }),
    ).rejects.toThrow("topic required");
    await expect(
      registerApnsRegistration({
        baseDir,
        distribution: "official",
        environment: "staging",
        installationId: "install-123",
        nodeId: "ios-node-relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        topic: "ai.openclaw.ios",
        transport: "relay",
      }),
    ).rejects.toThrow("relay registrations must use production environment");
    await expect(
      registerApnsRegistration({
        baseDir,
        distribution: "beta",
        environment: "production",
        installationId: "install-123",
        nodeId: "ios-node-relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        topic: "ai.openclaw.ios",
        transport: "relay",
      }),
    ).rejects.toThrow("relay registrations must use official distribution");
    await expect(
      registerApnsRegistration({
        baseDir,
        distribution: "official",
        environment: "production",
        installationId: "install-123",
        nodeId: "ios-node-relay",
        relayHandle: oversized,
        sendGrant: "send-grant-123",
        topic: "ai.openclaw.ios",
        transport: "relay",
      }),
    ).rejects.toThrow("relayHandle too long");
    await expect(
      registerApnsRegistration({
        baseDir,
        distribution: "official",
        environment: "production",
        installationId: oversized,
        nodeId: "ios-node-relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        topic: "ai.openclaw.ios",
        transport: "relay",
      }),
    ).rejects.toThrow("installationId too long");
    await expect(
      registerApnsRegistration({
        baseDir,
        distribution: "official",
        environment: "production",
        installationId: "install-123",
        nodeId: "ios-node-relay",
        relayHandle: "relay-handle-123",
        sendGrant: "x".repeat(1025),
        topic: "ai.openclaw.ios",
        transport: "relay",
      }),
    ).rejects.toThrow("sendGrant too long");
  });

  it("persists with a trailing newline and clears registrations", async () => {
    const baseDir = await makeTempDir();
    await registerApnsToken({
      baseDir,
      nodeId: "ios-node-1",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
    });

    const statePath = path.join(baseDir, "push", "apns-registrations.json");
    await expect(fs.readFile(statePath, "utf8")).resolves.toMatch(/\n$/);
    await expect(clearApnsRegistration("ios-node-1", baseDir)).resolves.toBe(true);
    await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toBeNull();
  });

  it("only clears a registration when the stored entry still matches", async () => {
    vi.useFakeTimers();
    try {
      const baseDir = await makeTempDir();
      vi.setSystemTime(new Date("2026-03-11T00:00:00Z"));
      const stale = await registerApnsToken({
        baseDir,
        environment: "sandbox",
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
      });

      vi.setSystemTime(new Date("2026-03-11T00:00:01Z"));
      const fresh = await registerApnsToken({
        baseDir,
        environment: "sandbox",
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
      });

      await expect(
        clearApnsRegistrationIfCurrent({
          baseDir,
          nodeId: "ios-node-1",
          registration: stale,
        }),
      ).resolves.toBe(false);
      await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toEqual(fresh);
    } finally {
      vi.useRealTimers();
    }
  });
});
