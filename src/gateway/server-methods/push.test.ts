import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { pushHandlers } from "./push.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  normalizeApnsEnvironment: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(),
}));

import {
  type ApnsPushResult,
  type ApnsRegistration,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

const DEFAULT_DIRECT_REGISTRATION = {
  environment: "sandbox",
  nodeId: "ios-node-1",
  token: "abcd",
  topic: "ai.openclaw.ios",
  transport: "direct",
  updatedAtMs: 1,
} as const;

const DEFAULT_RELAY_REGISTRATION = {
  distribution: "official",
  environment: "production",
  installationId: "install-123",
  nodeId: "ios-node-1",
  relayHandle: "relay-handle-123",
  sendGrant: "send-grant-123",
  tokenDebugSuffix: "abcd1234",
  topic: "ai.openclaw.ios",
  transport: "relay",
  updatedAtMs: 1,
} as const;

function directRegistration(
  overrides: Partial<Extract<ApnsRegistration, { transport: "direct" }>> = {},
): Extract<ApnsRegistration, { transport: "direct" }> {
  return { ...DEFAULT_DIRECT_REGISTRATION, ...overrides };
}

function relayRegistration(
  overrides: Partial<Extract<ApnsRegistration, { transport: "relay" }>> = {},
): Extract<ApnsRegistration, { transport: "relay" }> {
  return { ...DEFAULT_RELAY_REGISTRATION, ...overrides };
}

function mockDirectAuth() {
  vi.mocked(resolveApnsAuthConfigFromEnv).mockResolvedValue({
    ok: true,
    value: {
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      teamId: "TEAM123", // Pragma: allowlist secret
    },
  });
}

function apnsResult(overrides: Partial<ApnsPushResult>): ApnsPushResult {
  return {
    environment: "sandbox",
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    transport: "direct",
    ...overrides,
  };
}

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    invoke: async () =>
      await pushHandlers["push.test"]({
        client: null,
        context: {} as never,
        isWebchatConnect: () => false,
        params,
        req: { id: "req-1", method: "push.test", type: "req" },
        respond: respond as never,
      }),
    respond,
  };
}

function expectInvalidRequestResponse(
  respond: ReturnType<typeof vi.fn>,
  expectedMessagePart: string,
) {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(expectedMessagePart);
}

describe("push.test handler", () => {
  beforeEach(() => {
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({});
    vi.mocked(loadApnsRegistration).mockClear();
    vi.mocked(normalizeApnsEnvironment).mockClear();
    vi.mocked(resolveApnsAuthConfigFromEnv).mockClear();
    vi.mocked(resolveApnsRelayConfigFromEnv).mockClear();
    vi.mocked(sendApnsAlert).mockClear();
    vi.mocked(clearApnsRegistrationIfCurrent).mockClear();
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ title: "hello" });
    await invoke();
    expectInvalidRequestResponse(respond, "invalid push.test params");
  });

  it("returns invalid request when node has no APNs registration", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue(null);
    const { respond, invoke } = createInvokeParams({ nodeId: "ios-node-1" });
    await invoke();
    expectInvalidRequestResponse(respond, "has no APNs registration");
  });

  it("sends push test when registration and auth are available", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue(directRegistration());
    mockDirectAuth();
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue(apnsResult({}));

    const { respond, invoke } = createInvokeParams({
      body: "Ping",
      nodeId: "ios-node-1",
      title: "Wake",
    });
    await invoke();

    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, status: 200 });
  });

  it("sends push test through relay registrations", async () => {
    mocks.loadConfig.mockReturnValue({
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              timeoutMs: 1000,
            },
          },
        },
      },
    });
    vi.mocked(loadApnsRegistration).mockResolvedValue(
      relayRegistration({ installationId: "install-1" }),
    );
    vi.mocked(resolveApnsRelayConfigFromEnv).mockReturnValue({
      ok: true,
      value: {
        baseUrl: "https://relay.example.com",
        timeoutMs: 1000,
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue(
      apnsResult({
        environment: "production",
        tokenSuffix: "abcd1234",
        transport: "relay",
      }),
    );

    const { respond, invoke } = createInvokeParams({
      body: "Ping",
      nodeId: "ios-node-1",
      title: "Wake",
    });
    await invoke();

    expect(resolveApnsAuthConfigFromEnv).not.toHaveBeenCalled();
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(process.env, {
      push: {
        apns: {
          relay: {
            baseUrl: "https://relay.example.com",
            timeoutMs: 1000,
          },
        },
      },
    });
    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, status: 200, transport: "relay" });
  });

  it("clears stale registrations after invalid token push-test failures", async () => {
    const registration = directRegistration();
    vi.mocked(loadApnsRegistration).mockResolvedValue(registration);
    mockDirectAuth();
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue(
      apnsResult({
        ok: false,
        reason: "BadDeviceToken",
        status: 400,
      }),
    );
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(true);

    const { invoke } = createInvokeParams({
      body: "Ping",
      nodeId: "ios-node-1",
      title: "Wake",
    });
    await invoke();

    expect(clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({
      nodeId: "ios-node-1",
      registration,
    });
  });

  it("does not clear relay registrations after invalidation-shaped failures", async () => {
    const registration = relayRegistration();
    vi.mocked(loadApnsRegistration).mockResolvedValue(registration);
    vi.mocked(resolveApnsRelayConfigFromEnv).mockReturnValue({
      ok: true,
      value: {
        baseUrl: "https://relay.example.com",
        timeoutMs: 1000,
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    const result = apnsResult({
      environment: "production",
      ok: false,
      reason: "Unregistered",
      status: 410,
      tokenSuffix: "abcd1234",
      transport: "relay",
    });
    vi.mocked(sendApnsAlert).mockResolvedValue(result);
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);

    const { invoke } = createInvokeParams({
      body: "Ping",
      nodeId: "ios-node-1",
      title: "Wake",
    });
    await invoke();

    expect(shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      overrideEnvironment: null,
      registration,
      result,
    });
    expect(clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });

  it("does not clear direct registrations when push.test overrides the environment", async () => {
    const registration = directRegistration();
    vi.mocked(loadApnsRegistration).mockResolvedValue(registration);
    mockDirectAuth();
    vi.mocked(normalizeApnsEnvironment).mockReturnValue("production");
    const result = apnsResult({
      environment: "production",
      ok: false,
      reason: "BadDeviceToken",
      status: 400,
    });
    vi.mocked(sendApnsAlert).mockResolvedValue(result);
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);

    const { invoke } = createInvokeParams({
      body: "Ping",
      environment: "production",
      nodeId: "ios-node-1",
      title: "Wake",
    });
    await invoke();

    expect(shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      overrideEnvironment: "production",
      registration,
      result,
    });
    expect(clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });
});
