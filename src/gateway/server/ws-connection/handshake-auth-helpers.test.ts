import { describe, expect, it } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import type { ConnectParams } from "../../protocol/schema/types.js";
import {
  BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP,
  BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX,
  resolveHandshakeBrowserSecurityContext,
  resolvePairingLocality,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";

function createRateLimiter(): AuthRateLimiter {
  return {
    check: () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }),
    dispose: () => {},
    prune: () => {},
    recordFailure: () => {},
    reset: () => {},
    size: () => 0,
  };
}

describe("handshake auth helpers", () => {
  it("pins browser-origin loopback clients to the synthetic rate-limit ip", () => {
    const rateLimiter = createRateLimiter();
    const browserRateLimiter = createRateLimiter();
    const resolved = resolveHandshakeBrowserSecurityContext({
      browserRateLimiter,
      clientIp: "127.0.0.1",
      rateLimiter,
      requestOrigin: "https://app.example",
    });

    expect(resolved).toMatchObject({
      authRateLimiter: browserRateLimiter,
      enforceOriginCheckForAnyClient: true,
      hasBrowserOriginHeader: true,
      rateLimitClientIp: `${BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX}https://app.example`,
    });
  });

  it("falls back to the legacy synthetic ip when the browser origin is invalid", () => {
    const resolved = resolveHandshakeBrowserSecurityContext({
      clientIp: "127.0.0.1",
      requestOrigin: "not a url",
    });

    expect(resolved.rateLimitClientIp).toBe(BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP);
  });

  it("recommends device-token retry only for shared-token mismatch with device identity", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { token: "shared-token" },
      failedAuth: { ok: false, reason: "token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "token",
      canRetryWithDeviceToken: true,
      recommendedNextStep: "retry_with_device_token",
    });
  });

  it("treats explicit device-token mismatch as credential update guidance", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { deviceToken: "device-token" },
      failedAuth: { ok: false, reason: "device_token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "device-token",
      canRetryWithDeviceToken: false,
      recommendedNextStep: "update_auth_credentials",
    });
  });

  it("allows silent local pairing for not-paired, scope-upgrade and role-upgrade", () => {
    expect(
      shouldAllowSilentLocalPairing({
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        locality: "direct_local",
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        locality: "direct_local",
        reason: "role-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        locality: "direct_local",
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        hasBrowserOriginHeader: true,
        isControlUi: true,
        isWebchat: true,
        locality: "browser_container_local",
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        locality: "direct_local",
        reason: "metadata-upgrade",
      }),
    ).toBe(false);
  });
  it("rejects silent role-upgrade for remote clients", () => {
    expect(
      shouldAllowSilentLocalPairing({
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        locality: "remote",
        reason: "role-upgrade",
      }),
    ).toBe(false);
  });

  it("classifies direct local requests ahead of any Docker CLI fallback", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        hasProxyHeaders: true,
        isLocalClient: true,
        remoteAddress: "203.0.113.20",
        requestHost: "gateway.example",
        sharedAuthOk: false,
      }),
    ).toBe("direct_local");
  });

  it("classifies Docker-published loopback Control UI as browser-container-local", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: true,
        hasProxyHeaders: false,
        isLocalClient: false,
        remoteAddress: "172.17.0.1",
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
        sharedAuthOk: true,
      }),
    ).toBe("browser_container_local");
    expect(
      resolvePairingLocality({
        authMethod: "password",
        connectParams,
        hasBrowserOriginHeader: true,
        hasProxyHeaders: false,
        isLocalClient: false,
        remoteAddress: "172.17.0.1",
        requestHost: "localhost:18789",
        requestOrigin: "http://localhost:18789",
        sharedAuthOk: true,
      }),
    ).toBe("browser_container_local");
  });

  it("keeps Docker-published non-loopback Control UI origins remote", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    } as ConnectParams;
    const base = {
      authMethod: "token" as const,
      connectParams,
      hasBrowserOriginHeader: true,
      hasProxyHeaders: false,
      isLocalClient: false,
      remoteAddress: "172.17.0.1",
      sharedAuthOk: true,
    };

    expect(
      resolvePairingLocality({
        ...base,
        requestHost: "192.168.1.10:18789",
        requestOrigin: "http://192.168.1.10:18789",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "https://app.example",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        hasProxyHeaders: true,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
        sharedAuthOk: false,
      }),
    ).toBe("remote");
  });

  it("keeps non-Control-UI clients remote for browser-container-local conditions", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: true,
        hasProxyHeaders: false,
        isLocalClient: false,
        remoteAddress: "172.17.0.1",
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
        sharedAuthOk: true,
      }),
    ).toBe("remote");
  });

  it("classifies CLI loopback/private-host connects as cli_container_local only with shared auth", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        hasProxyHeaders: false,
        isLocalClient: false,
        remoteAddress: "127.0.0.1",
        requestHost: "172.17.0.2:18789",
        sharedAuthOk: true,
      }),
    ).toBe("cli_container_local");
    expect(
      resolvePairingLocality({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        hasProxyHeaders: true,
        isLocalClient: false,
        remoteAddress: "127.0.0.1",
        requestHost: "172.17.0.2:18789",
        sharedAuthOk: true,
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        hasProxyHeaders: false,
        isLocalClient: false,
        remoteAddress: "127.0.0.1",
        requestHost: "gateway.example",
        sharedAuthOk: true,
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        authMethod: "device-token",
        connectParams,
        hasBrowserOriginHeader: false,
        hasProxyHeaders: false,
        isLocalClient: false,
        remoteAddress: "127.0.0.1",
        requestHost: "172.17.0.2:18789",
        sharedAuthOk: true,
      }),
    ).toBe("remote");
  });

  it("keeps non-CLI clients remote when only the Docker CLI fallback conditions match", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        hasProxyHeaders: false,
        isLocalClient: false,
        remoteAddress: "127.0.0.1",
        requestHost: "172.17.0.2:18789",
        sharedAuthOk: true,
      }),
    ).toBe("remote");
  });

  it("skips backend self-pairing only for direct-local backend clients", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        locality: "direct_local",
        sharedAuthOk: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        locality: "remote",
        sharedAuthOk: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "password",
        connectParams,
        hasBrowserOriginHeader: false,
        locality: "remote",
        sharedAuthOk: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "device-token",
        connectParams,
        hasBrowserOriginHeader: false,
        locality: "direct_local",
        sharedAuthOk: false,
      }),
    ).toBe(true);
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "device-token",
        connectParams,
        hasBrowserOriginHeader: false,
        locality: "remote",
        sharedAuthOk: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        locality: "cli_container_local",
        sharedAuthOk: true,
      }),
    ).toBe(false);
  });

  it("does not skip backend self-pairing for CLI clients", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    } as ConnectParams;
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: false,
        locality: "direct_local",
        sharedAuthOk: true,
      }),
    ).toBe(false);
  });

  it("rejects pairing bypass when browser origin header is present", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      shouldSkipLocalBackendSelfPairing({
        authMethod: "token",
        connectParams,
        hasBrowserOriginHeader: true,
        locality: "direct_local",
        sharedAuthOk: true,
      }),
    ).toBe(false);
  });
});
