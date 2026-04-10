import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
  verifyDeviceSignature,
} from "./device-identity.js";
import { resolveApnsRelayConfigFromEnv, sendApnsRelayPush } from "./push-apns.relay.js";

const relayGatewayIdentity = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
  if (!deviceId) {
    throw new Error("failed to derive test gateway device id");
  }
  return {
    deviceId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKeyRaw,
  };
})();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createRelayPushParams() {
  return {
    gatewayIdentity: relayGatewayIdentity,
    payload: { aps: { "content-available": 1 } },
    priority: "5" as const,
    pushType: "background" as const,
    relayConfig: {
      baseUrl: "https://relay.example.com",
      timeoutMs: 1000,
    },
    relayHandle: "relay-handle-123",
    sendGrant: "send-grant-123",
  };
}

describe("push-apns.relay", () => {
  describe("resolveApnsRelayConfigFromEnv", () => {
    it("returns a missing-config error when no relay base URL is configured", () => {
      expect(resolveApnsRelayConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
        error:
          "APNs relay config missing: set gateway.push.apns.relay.baseUrl or OPENCLAW_APNS_RELAY_BASE_URL",
        ok: false,
      });
    });

    it("lets env overrides win and clamps tiny timeout values", () => {
      const resolved = resolveApnsRelayConfigFromEnv(
        {
          OPENCLAW_APNS_RELAY_BASE_URL: " https://relay-override.example.com/base/ ",
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: "999",
        } as NodeJS.ProcessEnv,
        {
          push: {
            apns: {
              relay: {
                baseUrl: "https://relay.example.com",
                timeoutMs: 2500,
              },
            },
          },
        },
      );

      expect(resolved).toMatchObject({
        ok: true,
        value: {
          baseUrl: "https://relay-override.example.com/base",
          timeoutMs: 1000,
        },
      });
    });

    it("allows loopback http URLs for alternate truthy env values", () => {
      const resolved = resolveApnsRelayConfigFromEnv({
        OPENCLAW_APNS_RELAY_ALLOW_HTTP: "yes",
        OPENCLAW_APNS_RELAY_BASE_URL: "http://[::1]:8787",
        OPENCLAW_APNS_RELAY_TIMEOUT_MS: "nope",
      } as NodeJS.ProcessEnv);

      expect(resolved).toMatchObject({
        ok: true,
        value: {
          baseUrl: "http://[::1]:8787",
          timeoutMs: 10_000,
        },
      });
    });

    it.each([
      {
        env: { OPENCLAW_APNS_RELAY_BASE_URL: "ftp://relay.example.com" },
        expected: "unsupported protocol",
        name: "unsupported protocol",
      },
      {
        env: {
          OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true",
          OPENCLAW_APNS_RELAY_BASE_URL: "http://relay.example.com",
        },
        expected: "loopback hosts",
        name: "http non-loopback host",
      },
      {
        env: { OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com/path?debug=1" },
        expected: "query and fragment are not allowed",
        name: "query string",
      },
      {
        env: { OPENCLAW_APNS_RELAY_BASE_URL: "https://user:pass@relay.example.com/path" },
        expected: "userinfo is not allowed",
        name: "userinfo",
      },
    ])("rejects invalid relay URL: $name", ({ env, expected }) => {
      const resolved = resolveApnsRelayConfigFromEnv(env as NodeJS.ProcessEnv);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error).toContain(expected);
      }
    });
  });

  describe("sendApnsRelayPush", () => {
    it("signs relay payloads and forwards the request through the injected sender", async () => {
      vi.spyOn(Date, "now").mockReturnValue(123_456_789);
      const sender = vi.fn().mockResolvedValue({
        apnsId: "relay-apns-id",
        environment: "production",
        ok: true,
        status: 200,
        tokenSuffix: "abcd1234",
      });

      const result = await sendApnsRelayPush({
        gatewayIdentity: relayGatewayIdentity,
        payload: { aps: { alert: { body: "Ping", title: "Wake" } } },
        priority: "10",
        pushType: "alert",
        relayConfig: {
          baseUrl: "https://relay.example.com",
          timeoutMs: 1000,
        },
        relayHandle: "relay-handle-123",
        requestSender: sender,
        sendGrant: "send-grant-123",
      });

      expect(sender).toHaveBeenCalledTimes(1);
      const sent = sender.mock.calls[0]?.[0];
      expect(sent).toMatchObject({
        gatewayDeviceId: relayGatewayIdentity.deviceId,
        payload: { aps: { alert: { body: "Ping", title: "Wake" } } },
        priority: "10",
        pushType: "alert",
        relayConfig: {
          baseUrl: "https://relay.example.com",
          timeoutMs: 1000,
        },
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        signedAtMs: 123_456_789,
      });
      expect(sent?.bodyJson).toBe(
        JSON.stringify({
          payload: { aps: { alert: { body: "Ping", title: "Wake" } } },
          priority: 10,
          pushType: "alert",
          relayHandle: "relay-handle-123",
        }),
      );
      expect(
        verifyDeviceSignature(
          relayGatewayIdentity.publicKey,
          [
            "openclaw-relay-send-v1",
            sent?.gatewayDeviceId,
            String(sent?.signedAtMs),
            sent?.bodyJson,
          ].join("\n"),
          sent?.signature ?? "",
        ),
      ).toBe(true);
      expect(result).toMatchObject({
        apnsId: "relay-apns-id",
        environment: "production",
        ok: true,
        status: 200,
        tokenSuffix: "abcd1234",
      });
    });

    it("does not follow relay redirects", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: vi.fn().mockRejectedValue(new Error("no body")),
        ok: false,
        status: 302,
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const result = await sendApnsRelayPush(createRelayPushParams());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
      expect(result).toMatchObject({
        environment: "production",
        ok: false,
        reason: "RelayRedirectNotAllowed",
        status: 302,
      });
    });

    it("falls back to fetch status when the relay body is not JSON", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: vi.fn().mockRejectedValue(new Error("bad json")),
        ok: true,
        status: 202,
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        apnsId: undefined,
        environment: "production",
        ok: true,
        reason: undefined,
        status: 202,
        tokenSuffix: undefined,
      });
    });

    it("normalizes relay JSON response fields", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          apnsId: " relay-apns-id ",
          ok: false,
          reason: " Unregistered ",
          status: 410,
          tokenSuffix: " abcd1234 ",
        }),
        ok: true,
        status: 202,
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        apnsId: "relay-apns-id",
        environment: "production",
        ok: false,
        reason: "Unregistered",
        status: 410,
        tokenSuffix: "abcd1234",
      });
    });
  });
});
