import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceHandlers } from "./devices.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const {
  getPairedDeviceMock,
  removePairedDeviceMock,
  revokeDeviceTokenMock,
  rotateDeviceTokenMock,
} = vi.hoisted(() => ({
  getPairedDeviceMock: vi.fn(),
  removePairedDeviceMock: vi.fn(),
  revokeDeviceTokenMock: vi.fn(),
  rotateDeviceTokenMock: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return {
    ...actual,
    getPairedDevice: getPairedDeviceMock,
    removePairedDevice: removePairedDeviceMock,
    revokeDeviceToken: revokeDeviceTokenMock,
    rotateDeviceToken: rotateDeviceTokenMock,
  };
});

function createClient(scopes: string[], deviceId?: string) {
  return {
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

function createOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    client: null,
    context: {
      disconnectClientsForDevice: vi.fn(),
      logGateway: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
    isWebchatConnect: () => false,
    params,
    req: { id: "req-1", method, params, type: "req" },
    respond: vi.fn(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function mockPairedOperatorDevice(): void {
  getPairedDeviceMock.mockResolvedValue({
    deviceId: "device-1",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing"],
    tokens: {
      operator: {
        createdAtMs: 123,
        role: "operator",
        scopes: ["operator.pairing"],
        token: "old-token",
      },
    },
  });
}

function mockRotateOperatorTokenSuccess(): void {
  rotateDeviceTokenMock.mockResolvedValue({
    entry: {
      createdAtMs: 456,
      role: "operator",
      rotatedAtMs: 789,
      scopes: ["operator.pairing"],
      token: "new-token",
    },
    ok: true,
  });
}

describe("deviceHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disconnects active clients after removing a paired device", async () => {
    removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1", removedAtMs: 123 });
    const opts = createOptions("device.pair.remove", { deviceId: " device-1 " });

    await deviceHandlers["device.pair.remove"](opts);
    await Promise.resolve();

    expect(removePairedDeviceMock).toHaveBeenCalledWith(" device-1 ");
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", removedAtMs: 123 },
      undefined,
    );
  });

  it("does not disconnect clients when device removal fails", async () => {
    removePairedDeviceMock.mockResolvedValue(null);
    const opts = createOptions("device.pair.remove", { deviceId: "device-1" });

    await deviceHandlers["device.pair.remove"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown deviceId" }),
    );
  });

  it("rejects removing another device from a non-admin device session", async () => {
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: "device-2" },
      { client: createClient(["operator.pairing"], "device-1") },
    );

    await deviceHandlers["device.pair.remove"](opts);

    expect(removePairedDeviceMock).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device pairing removal denied" }),
    );
  });

  it("treats normalized device ids as self-owned for paired device removal", async () => {
    removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1", removedAtMs: 123 });
    const opts = createOptions(
      "device.pair.remove",
      { deviceId: " device-1 " },
      { client: createClient(["operator.pairing"], "device-1") },
    );

    await deviceHandlers["device.pair.remove"](opts);

    expect(removePairedDeviceMock).toHaveBeenCalledWith(" device-1 ");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", removedAtMs: 123 },
      undefined,
    );
  });

  it("disconnects active clients after revoking a device token", async () => {
    revokeDeviceTokenMock.mockResolvedValue({ revokedAtMs: 456, role: "operator" });
    const opts = createOptions("device.token.revoke", {
      deviceId: " device-1 ",
      role: " operator ",
    });

    await deviceHandlers["device.token.revoke"](opts);
    await Promise.resolve();

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
    });
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", revokedAtMs: 456, role: "operator" },
      undefined,
    );
  });

  it("allows admin-scoped callers to revoke another device's token", async () => {
    revokeDeviceTokenMock.mockResolvedValue({ revokedAtMs: 456, role: "operator" });
    const opts = createOptions(
      "device.token.revoke",
      { deviceId: "device-2", role: "operator" },
      { client: createClient(["operator.admin"], "device-1") },
    );

    await deviceHandlers["device.token.revoke"](opts);

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: "device-2",
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-2", revokedAtMs: 456, role: "operator" },
      undefined,
    );
  });

  it("treats normalized device ids as self-owned for token revocation", async () => {
    revokeDeviceTokenMock.mockResolvedValue({ revokedAtMs: 456, role: "operator" });
    const opts = createOptions(
      "device.token.revoke",
      { deviceId: " device-1 ", role: "operator" },
      { client: createClient(["operator.pairing"], "device-1") },
    );

    await deviceHandlers["device.token.revoke"](opts);

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", revokedAtMs: 456, role: "operator" },
      undefined,
    );
  });

  it("disconnects active clients after rotating a device token", async () => {
    mockPairedOperatorDevice();
    mockRotateOperatorTokenSuccess();
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: " device-1 ",
        role: " operator ",
        scopes: ["operator.pairing"],
      },
      {
        client: {
          connect: {
            scopes: ["operator.pairing"],
          },
        } as never,
      },
    );

    await deviceHandlers["device.token.rotate"](opts);
    await Promise.resolve();

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
      scopes: ["operator.pairing"],
    });
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: " device-1 ",
        role: "operator",
        rotatedAtMs: 789,
        scopes: ["operator.pairing"],
        token: "new-token",
      },
      undefined,
    );
  });

  it("treats normalized device ids as self-owned for token rotation", async () => {
    mockPairedOperatorDevice();
    mockRotateOperatorTokenSuccess();
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: " device-1 ",
        role: "operator",
        scopes: ["operator.pairing"],
      },
      { client: createClient(["operator.pairing"], "device-1") },
    );

    await deviceHandlers["device.token.rotate"](opts);

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: "operator",
      scopes: ["operator.pairing"],
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: " device-1 ",
        role: "operator",
        rotatedAtMs: 789,
        scopes: ["operator.pairing"],
        token: "new-token",
      },
      undefined,
    );
  });

  it("rejects rotating a token for a role that was never approved", async () => {
    mockPairedOperatorDevice();
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: "device-1",
        role: "node",
      },
      {
        client: {
          connect: {
            scopes: ["operator.pairing"],
          },
        } as never,
      },
    );

    await deviceHandlers["device.token.rotate"](opts);

    expect(rotateDeviceTokenMock).not.toHaveBeenCalled();
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device token rotation denied" }),
    );
  });

  it("does not disconnect clients when token revocation fails", async () => {
    revokeDeviceTokenMock.mockResolvedValue(null);
    const opts = createOptions("device.token.revoke", {
      deviceId: "device-1",
      role: "operator",
    });

    await deviceHandlers["device.token.revoke"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown deviceId/role" }),
    );
  });
});
