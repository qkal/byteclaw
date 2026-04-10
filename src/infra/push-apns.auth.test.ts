import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  shouldClearStoredApnsRegistration,
  shouldInvalidateApnsRegistration,
} from "./push-apns.js";

const tempDirs = createTrackedTempDirs();

async function makeTempDir(): Promise<string> {
  return await tempDirs.make("openclaw-push-apns-auth-test-");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("push APNs auth and helper coverage", () => {
  it("normalizes APNs environment values", () => {
    expect(normalizeApnsEnvironment("sandbox")).toBe("sandbox");
    expect(normalizeApnsEnvironment(" PRODUCTION ")).toBe("production");
    expect(normalizeApnsEnvironment("staging")).toBeNull();
    expect(normalizeApnsEnvironment(null)).toBeNull();
  });

  it("prefers inline APNs private key values and unescapes newlines", async () => {
    const resolved = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_P8:
        "-----BEGIN PRIVATE KEY-----\\nline-a\\nline-b\\n-----END PRIVATE KEY-----", // Pragma: allowlist secret
      OPENCLAW_APNS_PRIVATE_KEY: "ignored",
    } as NodeJS.ProcessEnv);

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        keyId: "KEY123",
        teamId: "TEAM123",
      },
    });
    if (resolved.ok) {
      expect(resolved.value.privateKey).toContain("\nline-a\n");
      expect(resolved.value.privateKey).not.toBe("ignored");
    }
  });

  it("falls back to OPENCLAW_APNS_PRIVATE_KEY when OPENCLAW_APNS_PRIVATE_KEY_P8 is blank", async () => {
    const resolved = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nline-c\\nline-d\\n-----END PRIVATE KEY-----",
      OPENCLAW_APNS_PRIVATE_KEY_P8: "   ",
      OPENCLAW_APNS_TEAM_ID: "TEAM123", // Pragma: allowlist secret
    } as NodeJS.ProcessEnv);

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        keyId: "KEY123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nline-c\nline-d\n-----END PRIVATE KEY-----",
        teamId: "TEAM123",
      },
    });
  });

  it("reads APNs private keys from OPENCLAW_APNS_PRIVATE_KEY_PATH", async () => {
    const dir = await makeTempDir();
    const keyPath = path.join(dir, "apns-key.p8");
    await fs.writeFile(
      keyPath,
      "-----BEGIN PRIVATE KEY-----\\nline-e\\nline-f\\n-----END PRIVATE KEY-----\n",
      "utf8",
    );

    const resolved = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_PATH: keyPath,
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
    } as NodeJS.ProcessEnv);

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        keyId: "KEY123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nline-e\nline-f\n-----END PRIVATE KEY-----",
        teamId: "TEAM123",
      },
    });
  });

  it("reports missing auth fields and path read failures", async () => {
    const dir = await makeTempDir();
    const missingPath = path.join(dir, "missing-key.p8");

    await expect(resolveApnsAuthConfigFromEnv({} as NodeJS.ProcessEnv)).resolves.toEqual({
      error: "APNs auth missing: set OPENCLAW_APNS_TEAM_ID and OPENCLAW_APNS_KEY_ID",
      ok: false,
    });

    const missingKey = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_PATH: missingPath,
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
    } as NodeJS.ProcessEnv);

    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) {
      expect(missingKey.error).toContain(
        `failed reading OPENCLAW_APNS_PRIVATE_KEY_PATH (${missingPath})`,
      );
    }
  });

  it("invalidates only real bad-token APNs failures", () => {
    expect(shouldInvalidateApnsRegistration({ reason: "Unregistered", status: 410 })).toBe(true);
    expect(shouldInvalidateApnsRegistration({ reason: " BadDeviceToken ", status: 400 })).toBe(
      true,
    );
    expect(shouldInvalidateApnsRegistration({ reason: "BadTopic", status: 400 })).toBe(false);
    expect(shouldInvalidateApnsRegistration({ reason: "BadDeviceToken", status: 429 })).toBe(false);
  });

  it("clears only direct registrations without an environment override mismatch", () => {
    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          environment: "sandbox",
          nodeId: "ios-node-direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          transport: "direct",
          updatedAtMs: 1,
        },
        result: { reason: "BadDeviceToken", status: 400 },
      }),
    ).toBe(true);

    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          distribution: "official",
          environment: "production",
          installationId: "install-123",
          nodeId: "ios-node-relay",
          relayHandle: "relay-handle-123",
          sendGrant: "send-grant-123",
          topic: "ai.openclaw.ios",
          transport: "relay",
          updatedAtMs: 1,
        },
        result: { reason: "Unregistered", status: 410 },
      }),
    ).toBe(false);

    expect(
      shouldClearStoredApnsRegistration({
        overrideEnvironment: "production",
        registration: {
          environment: "sandbox",
          nodeId: "ios-node-direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          transport: "direct",
          updatedAtMs: 1,
        },
        result: { reason: "BadDeviceToken", status: 400 },
      }),
    ).toBe(false);
  });
});
