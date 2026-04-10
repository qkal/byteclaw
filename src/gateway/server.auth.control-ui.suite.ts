import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { startGatewayServer } from "./server.auth.shared.js";
import {
  BACKEND_GATEWAY_CLIENT,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  TEST_OPERATOR_CLIENT,
  TRUSTED_PROXY_CONTROL_UI_HEADERS,
  approvePendingPairingIfNeeded,
  configureTrustedProxyControlUiAuth,
  connectReq,
  createSignedDevice,
  ensurePairedDeviceTokenForCurrentIdentity,
  onceMessage,
  openWs,
  originForPort,
  readConnectChallengeNonce,
  restoreGatewayToken,
  rpcReq,
  startRateLimitedTokenServerWithPairedDeviceToken,
  startServerWithClient,
  testState,
  waitForWsClose,
  withGatewayServer,
  writeTrustedProxyControlUiConfig,
} from "./server.auth.shared.js";

let controlUiIdentityPathSeq = 0;

export function registerControlUiAndPairingSuite(): void {
  const trustedProxyControlUiCases: {
    name: string;
    role: "operator" | "node";
    withUnpairedNodeDevice: boolean;
    expectedOk: boolean;
    expectedErrorSubstring?: string;
    expectedErrorCode?: string;
  }[] = [
    {
      expectedErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
      expectedErrorSubstring: "control ui requires device identity",
      expectedOk: false,
      name: "rejects loopback trusted-proxy control ui operator without device identity",
      role: "operator",
      withUnpairedNodeDevice: false,
    },
    {
      expectedErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
      expectedErrorSubstring: "control ui requires device identity",
      expectedOk: false,
      name: "rejects trusted-proxy control ui node role without device identity",
      role: "node",
      withUnpairedNodeDevice: false,
    },
    {
      expectedErrorSubstring: "unauthorized",
      expectedOk: false,
      name: "rejects loopback trusted-proxy control ui node role before pairing",
      role: "node",
      withUnpairedNodeDevice: true,
    },
  ];

  const buildSignedDeviceForIdentity = async (params: {
    identityPath: string;
    client: { id: string; mode: string };
    nonce: string;
    scopes: string[];
    role?: "operator" | "node";
  }) => {
    const { device } = await createSignedDevice({
      clientId: params.client.id,
      clientMode: params.client.mode,
      identityPath: params.identityPath,
      nonce: params.nonce,
      role: params.role ?? "operator",
      scopes: params.scopes,
      token: "secret",
    });
    return device;
  };

  const REMOTE_BOOTSTRAP_HEADERS = {
    "x-forwarded-for": "10.0.0.14",
  };

  const expectStatusAndHealthOk = async (ws: WebSocket) => {
    const status = await rpcReq(ws, "status");
    expect(status.ok).toBe(true);
    const health = await rpcReq(ws, "health");
    expect(health.ok).toBe(true);
  };

  const expectAdminRpcOk = async (ws: WebSocket) => {
    const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
    expect(admin.ok).toBe(true);
  };

  const connectControlUiWithoutDeviceAndExpectOk = async (params: {
    ws: WebSocket;
    token?: string;
    password?: string;
    client?: { id: string; version: string; platform: string; mode: string };
  }) => {
    const res = await connectReq(params.ws, {
      ...(params.token ? { token: params.token } : {}),
      ...(params.password ? { password: params.password } : {}),
      client: { ...(params.client ?? CONTROL_UI_CLIENT) },
      device: null,
    });
    expect(res.ok).toBe(true);
    await expectStatusAndHealthOk(params.ws);
    await expectAdminRpcOk(params.ws);
  };

  const createOperatorIdentityFixture = async (identityPrefix: string) => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const identityDir = await mkdtemp(join(tmpdir(), identityPrefix));
    const identityPath = join(identityDir, "device.json");
    const identity = loadOrCreateDeviceIdentity(identityPath);
    return {
      client: { ...TEST_OPERATOR_CLIENT },
      identity,
      identityPath,
    };
  };

  const startServerWithOperatorIdentity = async (identityPrefix = "openclaw-device-scope-") => {
    const { server, ws, port, prevToken } = await startServerWithClient("secret", {
      controlUiEnabled: true,
    });
    const { identityPath, identity, client } = await createOperatorIdentityFixture(identityPrefix);
    return { client, identity, identityPath, port, prevToken, server, ws };
  };

  const withControlUiGatewayServer = async <T>(
    fn: (ctx: {
      port: number;
      server: Awaited<ReturnType<typeof startGatewayServer>>;
    }) => Promise<T>,
  ): Promise<T> =>
    await withGatewayServer(fn, {
      serverOptions: { controlUiEnabled: true },
    });

  const startControlUiServerWithClient = async (
    token?: string,
    opts?: Parameters<typeof startServerWithClient>[1],
  ) =>
    await startServerWithClient(token, {
      ...opts,
      controlUiEnabled: true,
    });

  const getRequiredPairedMetadata = (
    paired: Record<string, Record<string, unknown>>,
    deviceId: string,
  ) => {
    const metadata = paired[deviceId];
    expect(metadata).toBeTruthy();
    if (!metadata) {
      throw new Error(`Expected paired metadata for deviceId=${deviceId}`);
    }
    return metadata;
  };

  const stripPairedMetadataRolesAndScopes = async (deviceId: string) => {
    const { resolvePairingPaths, readJsonFile } = await import("../infra/pairing-files.js");
    const { writeJsonAtomic } = await import("../infra/json-files.js");
    const { pairedPath } = resolvePairingPaths(undefined, "devices");
    const paired = (await readJsonFile<Record<string, Record<string, unknown>>>(pairedPath)) ?? {};
    const legacy = getRequiredPairedMetadata(paired, deviceId);
    delete legacy.roles;
    delete legacy.scopes;
    await writeJsonAtomic(pairedPath, paired);
  };

  const seedApprovedOperatorReadPairing = async (params: {
    identityPrefix: string;
    clientId: string;
    clientMode: string;
    displayName: string;
    platform: string;
  }): Promise<{ identityPath: string; identity: { deviceId: string } }> => {
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { approveDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { identityPath, identity } = await createOperatorIdentityFixture(params.identityPrefix);
    const devicePublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const seeded = await requestDevicePairing({
      clientId: params.clientId,
      clientMode: params.clientMode,
      deviceId: identity.deviceId,
      displayName: params.displayName,
      platform: params.platform,
      publicKey: devicePublicKey,
      role: "operator",
      scopes: ["operator.read"],
    });
    await approveDevicePairing(seeded.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    return { identity: { deviceId: identity.deviceId }, identityPath };
  };

  for (const tc of trustedProxyControlUiCases) {
    test(tc.name, async () => {
      await configureTrustedProxyControlUiAuth();
      await withControlUiGatewayServer(async ({ port }) => {
        const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
        const scopes = tc.withUnpairedNodeDevice ? [] : undefined;
        let device: Awaited<ReturnType<typeof createSignedDevice>>["device"] | null = null;
        if (tc.withUnpairedNodeDevice) {
          const challengeNonce = await readConnectChallengeNonce(ws);
          expect(challengeNonce).toBeTruthy();
          ({ device } = await createSignedDevice({
            clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
            nonce: String(challengeNonce),
            role: "node",
            scopes: [],
            token: null,
          }));
        }
        const res = await connectReq(ws, {
          client: { ...CONTROL_UI_CLIENT },
          device,
          role: tc.role,
          scopes,
          skipDefaultAuth: true,
        });
        expect(res.ok).toBe(tc.expectedOk);
        if (!tc.expectedOk) {
          if (tc.expectedErrorSubstring) {
            expect(res.error?.message ?? "").toContain(tc.expectedErrorSubstring);
          }
          if (tc.expectedErrorCode) {
            expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
              tc.expectedErrorCode,
            );
          }
          ws.close();
          return;
        }
        ws.close();
      });
    });
  }

  test("rejects trusted-proxy control ui without device identity even with self-declared scopes", async () => {
    await configureTrustedProxyControlUiAuth();
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { rejectDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { identity } = await createOperatorIdentityFixture("openclaw-control-ui-trusted-proxy-");
    const pendingRequest = await requestDevicePairing({
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "operator",
      scopes: ["operator.admin"],
    });
    await withControlUiGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const res = await connectReq(ws, {
          client: { ...CONTROL_UI_CLIENT },
          device: null,
          scopes: ["operator.admin"],
          skipDefaultAuth: true,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("control ui requires device identity");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        );
      } finally {
        ws.close();
        await rejectDevicePairing(pendingRequest.request.requestId);
      }
    });
  });

  test("allows localhost control ui without device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    const { server, ws, prevToken } = await startControlUiServerWithClient("secret", {
      wsHeaders: { origin: "http://127.0.0.1" },
    });
    await connectControlUiWithoutDeviceAndExpectOk({ token: "secret", ws });
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows localhost tui without device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    const { server, ws, prevToken } = await startControlUiServerWithClient("secret");
    await connectControlUiWithoutDeviceAndExpectOk({
      client: {
        id: GATEWAY_CLIENT_NAMES.TUI,
        mode: GATEWAY_CLIENT_MODES.UI,
        platform: "darwin",
        version: "1.0.0",
      },
      token: "secret",
      ws,
    });
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows control ui password-only auth on localhost when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    testState.gatewayAuth = { mode: "password", password: "secret" }; // Pragma: allowlist secret
    await withControlUiGatewayServer(async ({ port }) => {
      const ws = await openWs(port, { origin: originForPort(port) });
      await connectControlUiWithoutDeviceAndExpectOk({ password: "secret", ws }); // Pragma: allowlist secret
      ws.close();
    });
  });

  test("does not bypass pairing for control ui device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = {
      allowInsecureAuth: true,
      allowedOrigins: ["https://localhost"],
    };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    await writeTrustedProxyControlUiConfig({ allowInsecureAuth: true });
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withControlUiGatewayServer(async ({ port }) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            origin: "https://localhost",
            "x-forwarded-for": "203.0.113.10",
          },
        });
        const challengePromise = onceMessage<{
          type?: string;
          event?: string;
          payload?: Record<string, unknown> | null;
        }>(ws, (o) => o.type === "event" && o.event === "connect.challenge");
        await new Promise<void>((resolve) => ws.once("open", resolve));
        const challenge = await challengePromise;
        const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
        expect(typeof nonce).toBe("string");
        const os = await import("node:os");
        const path = await import("node:path");
        const scopes = [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
        ];
        const { device } = await createSignedDevice({
          clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
          identityPath: path.join(
            os.tmpdir(),
            `openclaw-controlui-device-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${controlUiIdentityPathSeq++}.json`,
          ),
          nonce: String(nonce),
          scopes,
          token: "secret",
        });
        const res = await connectReq(ws, {
          client: {
            ...CONTROL_UI_CLIENT,
          },
          device,
          scopes,
          token: "secret",
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.PAIRING_REQUIRED,
        );
        ws.close();
      });
    } finally {
      restoreGatewayToken(prevToken);
    }
  });

  test("allows control ui with stale device identity when device auth is disabled", async () => {
    testState.gatewayControlUi = { dangerouslyDisableDeviceAuth: true };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withControlUiGatewayServer(async ({ port }) => {
        const ws = await openWs(port, { origin: originForPort(port) });
        const challengeNonce = await readConnectChallengeNonce(ws);
        expect(challengeNonce).toBeTruthy();
        const { device } = await createSignedDevice({
          clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
          nonce: String(challengeNonce),
          scopes: [],
          signedAtMs: Date.now() - 60 * 60 * 1000,
          token: "secret",
        });
        const res = await connectReq(ws, {
          client: {
            ...CONTROL_UI_CLIENT,
          },
          device,
          scopes: ["operator.read"],
          token: "secret",
        });
        expect(res.ok).toBe(true);
        expect((res.payload as { auth?: unknown } | undefined)?.auth).toBeUndefined();
        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);
        ws.close();
      });
    } finally {
      restoreGatewayToken(prevToken);
    }
  });

  test("preserves requested control ui scopes when dangerouslyDisableDeviceAuth bypasses device identity", async () => {
    testState.gatewayControlUi = { dangerouslyDisableDeviceAuth: true };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withControlUiGatewayServer(async ({ port }) => {
        const ws = await openWs(port, { origin: originForPort(port) });
        const res = await connectReq(ws, {
          client: {
            ...CONTROL_UI_CLIENT,
          },
          scopes: ["operator.read"],
          token: "secret",
        });
        expect(res.ok).toBe(true);

        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);

        const talk = await rpcReq(ws, "chat.history", { limit: 1, sessionKey: "main" });
        expect(talk.ok).toBe(true);
        ws.close();
      });
    } finally {
      restoreGatewayToken(prevToken);
    }
  });

  test("device token auth matrix", async () => {
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    const { deviceToken, deviceIdentityPath } = await ensurePairedDeviceTokenForCurrentIdentity(ws);
    ws.close();

    const scenarios: {
      name: string;
      opts: Parameters<typeof connectReq>[1];
      assert: (res: Awaited<ReturnType<typeof connectReq>>) => void;
    }[] = [
      {
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
        name: "accepts device token auth for paired device",
        opts: { token: deviceToken },
      },
      {
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
        name: "accepts explicit auth.deviceToken when shared token is omitted",
        opts: {
          deviceToken,
          skipDefaultAuth: true,
        },
      },
      {
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
        name: "uses explicit auth.deviceToken fallback when shared token is wrong",
        opts: {
          deviceToken,
          token: "wrong",
        },
      },
      {
        assert: (res) => {
          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain("gateway token mismatch");
          expect(res.error?.message ?? "").not.toContain("device token mismatch");
          const details = res.error?.details as
            | {
                code?: string;
                canRetryWithDeviceToken?: boolean;
                recommendedNextStep?: string;
              }
            | undefined;
          expect(details?.code).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH);
          expect(details?.canRetryWithDeviceToken).toBe(true);
          expect(details?.recommendedNextStep).toBe("retry_with_device_token");
        },
        name: "keeps shared token mismatch reason when fallback device-token check fails",
        opts: { token: "wrong" },
      },
      {
        assert: (res) => {
          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain("device token mismatch");
          expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
            ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
          );
        },
        name: "reports device token mismatch when explicit auth.deviceToken is wrong",
        opts: {
          deviceToken: "not-a-valid-device-token",
          skipDefaultAuth: true,
        },
      },
    ];

    try {
      for (const scenario of scenarios) {
        const ws2 = await openWs(port);
        try {
          const res = await connectReq(ws2, {
            ...scenario.opts,
            deviceIdentityPath,
          });
          scenario.assert(res);
        } finally {
          ws2.close();
        }
      }
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps shared-secret lockout separate from device-token auth", async () => {
    const { server, port, prevToken, deviceToken, deviceIdentityPath } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadShared = await openWs(port);
      const badShared = await connectReq(wsBadShared, { device: null, token: "wrong" });
      expect(badShared.ok).toBe(false);
      wsBadShared.close();

      const wsSharedLocked = await openWs(port);
      const sharedLocked = await connectReq(wsSharedLocked, { device: null, token: "secret" });
      expect(sharedLocked.ok).toBe(false);
      expect(sharedLocked.error?.message ?? "").toContain("retry later");
      wsSharedLocked.close();

      const wsDevice = await openWs(port);
      const deviceOk = await connectReq(wsDevice, { deviceIdentityPath, token: deviceToken });
      expect(deviceOk.ok).toBe(true);
      wsDevice.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps device-token lockout separate from shared-secret auth", async () => {
    const { server, port, prevToken, deviceToken, deviceIdentityPath } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadDevice = await openWs(port);
      const badDevice = await connectReq(wsBadDevice, {
        deviceIdentityPath,
        deviceToken: "wrong",
        skipDefaultAuth: true,
      });
      expect(badDevice.ok).toBe(false);
      wsBadDevice.close();

      const wsDeviceLocked = await openWs(port);
      const deviceLocked = await connectReq(wsDeviceLocked, {
        deviceIdentityPath,
        deviceToken: "wrong",
        skipDefaultAuth: true,
      });
      expect(deviceLocked.ok).toBe(false);
      expect(deviceLocked.error?.message ?? "").toContain("retry later");
      wsDeviceLocked.close();

      const wsShared = await openWs(port);
      const sharedOk = await connectReq(wsShared, { device: null, token: "secret" });
      expect(sharedOk.ok).toBe(true);
      wsShared.close();

      const wsDeviceReal = await openWs(port);
      const deviceStillLocked = await connectReq(wsDeviceReal, {
        deviceIdentityPath,
        token: deviceToken,
      });
      expect(deviceStillLocked.ok).toBe(false);
      expect(deviceStillLocked.error?.message ?? "").toContain("retry later");
      wsDeviceReal.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("auto-approves local-direct operator pairing despite a remote-looking host header", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken, identityPath, identity, client } =
      await startServerWithOperatorIdentity();
    ws.close();

    const wsRemoteRead = await openWs(port, { host: "gateway.example" });
    const initialNonce = await readConnectChallengeNonce(wsRemoteRead);
    const initial = await connectReq(wsRemoteRead, {
      client,
      device: await buildSignedDeviceForIdentity({
        client,
        identityPath,
        nonce: initialNonce,
        scopes: ["operator.read"],
      }),
      scopes: ["operator.read"],
      token: "secret",
    });
    expect(initial.ok).toBe(true);
    let pairing = await listDevicePairing();
    const pendingAfterRead = pairing.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingAfterRead).toHaveLength(0);
    expect(await getPairedDevice(identity.deviceId)).toBeTruthy();
    wsRemoteRead.close();

    const ws2 = await openWs(port, { host: "gateway.example" });
    const nonce2 = await readConnectChallengeNonce(ws2);
    const res = await connectReq(ws2, {
      client,
      device: await buildSignedDeviceForIdentity({
        client,
        identityPath,
        nonce: nonce2,
        scopes: ["operator.admin"],
      }),
      scopes: ["operator.admin"],
      token: "secret",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("pairing required");
    pairing = await listDevicePairing();
    const pendingAfterAdmin = pairing.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingAfterAdmin).toHaveLength(1);
    expect(pendingAfterAdmin[0]?.scopes ?? []).toEqual(expect.arrayContaining(["operator.admin"]));
    expect(await getPairedDevice(identity.deviceId)).toBeTruthy();
    ws2.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("requires approval for loopback scope upgrades for control ui clients", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
      displayName: "loopback-control-ui-upgrade",
      identityPrefix: "openclaw-device-token-scope-",
      platform: CONTROL_UI_CLIENT.platform,
    });

    ws.close();

    const ws2 = await openWs(port, { origin: originForPort(port) });
    const nonce2 = await readConnectChallengeNonce(ws2);
    const upgraded = await connectReq(ws2, {
      client: { ...CONTROL_UI_CLIENT },
      device: await buildSignedDeviceForIdentity({
        client: CONTROL_UI_CLIENT,
        identityPath,
        nonce: nonce2,
        scopes: ["operator.admin"],
      }),
      scopes: ["operator.admin"],
      token: "secret",
    });
    expect(upgraded.ok).toBe(false);
    expect(upgraded.error?.message ?? "").toContain("pairing required");
    const pending = await listDevicePairing();
    const pendingUpgrade = pending.pending.filter((entry) => entry.deviceId === identity.deviceId);
    expect(pendingUpgrade).toHaveLength(1);
    expect(pendingUpgrade[0]?.scopes ?? []).toEqual(expect.arrayContaining(["operator.admin"]));
    const updated = await getPairedDevice(identity.deviceId);
    expect(updated?.tokens?.operator?.scopes ?? []).not.toContain("operator.admin");

    ws2.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("auto-approves fresh node bootstrap pairing from qr setup code", async () => {
    const { issueDeviceBootstrapToken, verifyDeviceBootstrapToken } =
      await import("../infra/device-bootstrap.js");
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { getPairedDevice, listDevicePairing, verifyDeviceToken } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-node-",
    );
    const client = {
      deviceFamily: "iPhone",
      id: "openclaw-ios",
      mode: "node",
      platform: "iOS 26.3.1",
      version: "2026.3.30",
    };

    try {
      const issued = await issueDeviceBootstrapToken();
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsBootstrap, {
        bootstrapToken: issued.token,
        client,
        deviceIdentityPath: identityPath,
        role: "node",
        scopes: [],
        skipDefaultAuth: true,
      });
      expect(initial.ok).toBe(true);
      const initialPayload = initial.payload as
        | {
            type?: string;
            auth?: {
              deviceToken?: string;
              role?: string;
              scopes?: string[];
              deviceTokens?: {
                deviceToken?: string;
                role?: string;
                scopes?: string[];
              }[];
            };
          }
        | undefined;
      expect(initialPayload?.type).toBe("hello-ok");
      const issuedDeviceToken = initialPayload?.auth?.deviceToken;
      const issuedOperatorToken = initialPayload?.auth?.deviceTokens?.find(
        (entry) => entry.role === "operator",
      )?.deviceToken;
      expect(issuedDeviceToken).toBeDefined();
      expect(issuedOperatorToken).toBeDefined();
      expect(initialPayload?.auth?.role).toBe("node");
      expect(initialPayload?.auth?.scopes ?? []).toEqual([]);
      expect(initialPayload?.auth?.deviceTokens?.some((entry) => entry.role === "node")).toBe(
        false,
      );
      expect(
        initialPayload?.auth?.deviceTokens?.find((entry) => entry.role === "operator")?.scopes,
      ).toEqual(
        expect.arrayContaining([
          "operator.approvals",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ]),
      );
      expect(
        initialPayload?.auth?.deviceTokens?.find((entry) => entry.role === "operator")?.scopes,
      ).not.toEqual(
        expect.arrayContaining(["node.camera", "node.display", "node.exec", "node.voice"]),
      );
      expect(
        initialPayload?.auth?.deviceTokens?.find((entry) => entry.role === "operator")?.scopes,
      ).not.toEqual(expect.arrayContaining(["operator.admin", "operator.pairing"]));

      const afterBootstrap = await listDevicePairing();
      expect(
        afterBootstrap.pending.filter((entry) => entry.deviceId === identity.deviceId),
      ).toEqual([]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
      expect(paired?.approvedScopes ?? []).toEqual(
        expect.arrayContaining([
          "operator.approvals",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ]),
      );
      expect(paired?.tokens?.node?.token).toBe(issuedDeviceToken);
      expect(paired?.tokens?.operator?.token).toBe(issuedOperatorToken);
      if (!issuedDeviceToken || !issuedOperatorToken) {
        throw new Error("expected hello-ok auth.deviceTokens for bootstrap onboarding");
      }

      await new Promise<void>((resolve) => {
        if (wsBootstrap.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        wsBootstrap.once("close", () => resolve());
        wsBootstrap.close();
      });

      const wsReplay = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const replay = await connectReq(wsReplay, {
        bootstrapToken: issued.token,
        client,
        deviceIdentityPath: identityPath,
        role: "node",
        scopes: [],
        skipDefaultAuth: true,
      });
      expect(replay.ok).toBe(false);
      expect((replay.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
      );
      wsReplay.close();

      const wsReconnect = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const reconnect = await connectReq(wsReconnect, {
        client,
        deviceIdentityPath: identityPath,
        deviceToken: issuedDeviceToken,
        role: "node",
        scopes: [],
        skipDefaultAuth: true,
      });
      expect(reconnect.ok).toBe(true);
      wsReconnect.close();

      await expect(
        verifyDeviceBootstrapToken({
          deviceId: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          role: "node",
          scopes: [],
          token: issued.token,
        }),
      ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          role: "node",
          scopes: [],
          token: issuedDeviceToken,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          role: "operator",
          scopes: [
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
          token: issuedOperatorToken,
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("does not consume bootstrap token when node reconcile fails before hello-ok", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const reconcileModule = await import("./node-connect-reconcile.js");
    const reconcileSpy = vi
      .spyOn(reconcileModule, "reconcileNodePairingOnConnect")
      .mockRejectedValueOnce(new Error("boom"));
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();

    const { identityPath, client } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-reconcile-fail-",
    );
    const nodeClient = {
      ...client,
      id: "openclaw-android",
      mode: "node",
    };

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });

      const wsFail = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      await expect(
        connectReq(wsFail, {
          bootstrapToken: issued.token,
          client: nodeClient,
          deviceIdentityPath: identityPath,
          role: "node",
          scopes: [],
          skipDefaultAuth: true,
          timeoutMs: 500,
        }),
      ).rejects.toThrow();
      // The full agentic shard can saturate the event loop enough that the
      // Server-side close after a pre-hello failure arrives later than 1s.
      await expect(waitForWsClose(wsFail, 5000)).resolves.toBe(true);

      const wsRetry = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const retry = await connectReq(wsRetry, {
        bootstrapToken: issued.token,
        client: nodeClient,
        deviceIdentityPath: identityPath,
        role: "node",
        scopes: [],
        skipDefaultAuth: true,
      });
      expect(retry.ok).toBe(true);
      wsRetry.close();
    } finally {
      reconcileSpy.mockRestore();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires approval for bootstrap-auth role upgrades on already-paired devices", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-role-upgrade-",
    );
    const client = {
      deviceFamily: "iPhone",
      id: "openclaw-ios",
      mode: "node",
      platform: "iOS 26.3.1",
      version: "2026.3.30",
    };

    try {
      const seededRequest = await requestDevicePairing({
        clientId: client.id,
        clientMode: client.mode,
        deviceFamily: client.deviceFamily,
        deviceId: identity.deviceId,
        platform: client.platform,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes: ["operator.read"],
      });
      await approveDevicePairing(seededRequest.request.requestId, {
        callerScopes: ["operator.read"],
      });

      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });
      const wsUpgrade = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const upgrade = await connectReq(wsUpgrade, {
        bootstrapToken: issued.token,
        client,
        deviceIdentityPath: identityPath,
        role: "node",
        scopes: [],
        skipDefaultAuth: true,
      });
      expect(upgrade.ok).toBe(false);
      expect(upgrade.error?.message ?? "").toContain("pairing required");
      expect((upgrade.error?.details as { code?: string; reason?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      );
      expect(
        (upgrade.error?.details as { code?: string; reason?: string } | undefined)?.reason,
      ).toBe("role-upgrade");

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("node");
      expect(pending[0]?.roles).toEqual(["node"]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(expect.arrayContaining(["operator"]));
      wsUpgrade.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires approval for bootstrap-auth operator pairing outside the qr baseline profile", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();

    const { identityPath, identity, client } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-operator-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["operator"],
          scopes: ["operator.read"],
        },
      });
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsBootstrap, {
        bootstrapToken: issued.token,
        client,
        deviceIdentityPath: identityPath,
        role: "operator",
        scopes: ["operator.read"],
        skipDefaultAuth: true,
      });
      expect(initial.ok).toBe(false);
      expect(initial.error?.message ?? "").toContain("pairing required");
      expect((initial.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      );

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("operator");
      expect(pending[0]?.scopes ?? []).toEqual(expect.arrayContaining(["operator.read"]));
      expect(await getPairedDevice(identity.deviceId)).toBeNull();
      wsBootstrap.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("auto-approves local-direct node pairing, then queues operator scope approval", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();
    const { identityPath, identity, client } =
      await createOperatorIdentityFixture("openclaw-device-scope-");
    const connectWithNonce = async (role: "operator" | "node", scopes: string[]) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { host: "gateway.example" },
      });
      const challengePromise = onceMessage<{
        type?: string;
        event?: string;
        payload?: Record<string, unknown> | null;
      }>(socket, (o) => o.type === "event" && o.event === "connect.challenge");
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const challenge = await challengePromise;
      const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
      expect(typeof nonce).toBe("string");
      const result = await connectReq(socket, {
        client,
        device: await buildSignedDeviceForIdentity({
          client,
          identityPath,
          nonce: String(nonce),
          role,
          scopes,
        }),
        role,
        scopes,
        token: "secret",
      });
      socket.close();
      return result;
    };

    const nodeConnect = await connectWithNonce("node", []);
    expect(nodeConnect.ok).toBe(true);

    const operatorConnect = await connectWithNonce("operator", ["operator.read", "operator.write"]);
    expect(operatorConnect.ok).toBe(false);
    expect(operatorConnect.error?.message ?? "").toContain("pairing required");

    const pending = await listDevicePairing();
    const pendingForTestDevice = pending.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingForTestDevice).toHaveLength(1);
    expect(pendingForTestDevice[0]?.scopes ?? []).toEqual(
      expect.arrayContaining(["operator.read", "operator.write"]),
    );

    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(paired?.approvedScopes ?? []).toEqual(
      expect.arrayContaining(["operator.read", "operator.write"]),
    );

    const approvedOperatorConnect = await connectWithNonce("operator", ["operator.read"]);
    expect(approvedOperatorConnect.ok).toBe(true);

    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows operator.read connect when device is paired with operator.admin", async () => {
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken, identityPath, identity, client } =
      await startServerWithOperatorIdentity();

    const initialNonce = await readConnectChallengeNonce(ws);
    const initial = await connectReq(ws, {
      client,
      device: await buildSignedDeviceForIdentity({
        client,
        identityPath,
        nonce: initialNonce,
        scopes: ["operator.admin"],
      }),
      scopes: ["operator.admin"],
      token: "secret",
    });
    if (!initial.ok) {
      await approvePendingPairingIfNeeded();
    }

    ws.close();

    const ws2 = await openWs(port);
    const nonce2 = await readConnectChallengeNonce(ws2);
    const res = await connectReq(ws2, {
      client,
      device: await buildSignedDeviceForIdentity({
        client,
        identityPath,
        nonce: nonce2,
        scopes: ["operator.read"],
      }),
      scopes: ["operator.read"],
      token: "secret",
    });
    expect(res.ok).toBe(true);
    ws2.close();

    const list = await listDevicePairing();
    expect(list.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);

    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows operator shared auth with legacy paired metadata", async () => {
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-device-legacy-meta-",
    );
    const { deviceId } = identity;
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const pending = await requestDevicePairing({
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
      deviceId,
      displayName: "legacy-test",
      platform: "test",
      publicKey,
      role: "operator",
      scopes: ["operator.read"],
    });
    await approveDevicePairing(pending.request.requestId, {
      callerScopes: pending.request.scopes ?? ["operator.admin"],
    });

    await stripPairedMetadataRolesAndScopes(deviceId);

    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    let ws2: WebSocket | undefined;
    try {
      ws.close();

      const wsReconnect = await openWs(port);
      ws2 = wsReconnect;
      const reconnectNonce = await readConnectChallengeNonce(wsReconnect);
      const reconnect = await connectReq(wsReconnect, {
        client: TEST_OPERATOR_CLIENT,
        device: await buildSignedDeviceForIdentity({
          client: TEST_OPERATOR_CLIENT,
          identityPath,
          nonce: reconnectNonce,
          scopes: ["operator.read"],
        }),
        scopes: ["operator.read"],
        token: "secret",
      });
      expect(reconnect.ok).toBe(true);

      const repaired = await getPairedDevice(deviceId);
      expect(repaired?.role).toBe("operator");
      expect(repaired?.approvedScopes ?? []).toContain("operator.read");
      expect(repaired?.tokens?.operator?.scopes ?? []).toContain("operator.read");
      const list = await listDevicePairing();
      expect(list.pending.filter((entry) => entry.deviceId === deviceId)).toEqual([]);
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
      ws.close();
      ws2?.close();
    }
  });

  test("requires approval for local scope upgrades even when paired metadata is legacy-shaped", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
      displayName: "legacy-upgrade-test",
      identityPrefix: "openclaw-device-legacy-",
      platform: "test",
    });

    await stripPairedMetadataRolesAndScopes(identity.deviceId);

    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    let ws2: WebSocket | undefined;
    try {
      const client = { ...TEST_OPERATOR_CLIENT };

      ws.close();

      const wsUpgrade = await openWs(port);
      ws2 = wsUpgrade;
      const upgradeNonce = await readConnectChallengeNonce(wsUpgrade);
      const upgraded = await connectReq(wsUpgrade, {
        client,
        device: await buildSignedDeviceForIdentity({
          client,
          identityPath,
          nonce: upgradeNonce,
          scopes: ["operator.admin"],
        }),
        scopes: ["operator.admin"],
        token: "secret",
      });
      expect(upgraded.ok).toBe(false);
      expect(upgraded.error?.message ?? "").toContain("pairing required");
      wsUpgrade.close();

      const pendingUpgrade = (await listDevicePairing()).pending.find(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pendingUpgrade).toBeTruthy();
      expect(pendingUpgrade?.scopes ?? []).toEqual(expect.arrayContaining(["operator.admin"]));
      const repaired = await getPairedDevice(identity.deviceId);
      expect(repaired?.role).toBe("operator");
      expect(repaired?.approvedScopes ?? []).toEqual(expect.arrayContaining(["operator.read"]));
    } finally {
      ws.close();
      ws2?.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("rejects revoked device token", async () => {
    const { revokeDeviceToken } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    const { identity, deviceToken, deviceIdentityPath } =
      await ensurePairedDeviceTokenForCurrentIdentity(ws);

    await revokeDeviceToken({ deviceId: identity.deviceId, role: "operator" });

    ws.close();

    const ws2 = await openWs(port);
    const res2 = await connectReq(ws2, { deviceIdentityPath, token: deviceToken });
    expect(res2.ok).toBe(false);

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  test("allows local gateway backend shared-auth connections without device pairing", async () => {
    const { server, ws, prevToken } = await startControlUiServerWithClient("secret");
    try {
      const localBackend = await connectReq(ws, {
        client: BACKEND_GATEWAY_CLIENT,
        token: "secret",
      });
      expect(localBackend.ok).toBe(true);
    } finally {
      ws.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("auto-approves Docker-style CLI connects on loopback with a private host header", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();
    const wsDockerCli = await openWs(port, { host: "172.17.0.2:18789" });
    try {
      const { identity, identityPath } =
        await createOperatorIdentityFixture("openclaw-cli-docker-");
      const nonce = await readConnectChallengeNonce(wsDockerCli);
      const dockerCli = await connectReq(wsDockerCli, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          platform: "linux",
          version: "1.0.0",
        },
        device: await buildSignedDeviceForIdentity({
          client: {
            id: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
          },
          identityPath,
          nonce,
          scopes: ["operator.admin"],
        }),
        token: "secret",
      });
      expect(dockerCli.ok).toBe(true);
      const pending = await listDevicePairing();
      expect(pending.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);
      expect(await getPairedDevice(identity.deviceId)).toBeTruthy();
    } finally {
      wsDockerCli.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("allows gateway backend clients on loopback even with a remote-looking host header", async () => {
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();
    const wsRemoteLike = await openWs(port, { host: "gateway.example" });
    try {
      const remoteLikeBackend = await connectReq(wsRemoteLike, {
        client: BACKEND_GATEWAY_CLIENT,
        token: "secret",
      });
      expect(remoteLikeBackend.ok).toBe(true);
    } finally {
      wsRemoteLike.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("allows gateway backend clients on loopback with a private host header", async () => {
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();
    const wsPrivateHost = await openWs(port, { host: "172.17.0.2:18789" });
    try {
      const remoteLikeBackend = await connectReq(wsPrivateHost, {
        client: BACKEND_GATEWAY_CLIENT,
        token: "secret",
      });
      expect(remoteLikeBackend.ok).toBe(true);
    } finally {
      wsPrivateHost.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("allows CLI clients on loopback even when the host header is not private-or-loopback", async () => {
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    ws.close();
    const wsRemoteLike = await openWs(port, { host: "gateway.example" });
    try {
      const remoteCli = await connectReq(wsRemoteLike, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          platform: "linux",
          version: "1.0.0",
        },
        token: "secret",
      });
      expect(remoteCli.ok).toBe(true);
    } finally {
      wsRemoteLike.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });
}
