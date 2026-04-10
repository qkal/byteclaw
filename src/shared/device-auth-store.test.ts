import { describe, expect, it, vi } from "vitest";
import {
  type DeviceAuthStoreAdapter,
  clearDeviceAuthTokenFromStore,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "./device-auth-store.js";

function createAdapter(initialStore: ReturnType<DeviceAuthStoreAdapter["readStore"]> = null) {
  let store = initialStore;
  const writes: unknown[] = [];
  const adapter: DeviceAuthStoreAdapter = {
    readStore: () => store,
    writeStore: (next) => {
      store = next;
      writes.push(next);
    },
  };
  return { adapter, readStore: () => store, writes };
}

describe("device-auth-store", () => {
  it("loads only matching device ids and normalized roles", () => {
    const { adapter } = createAdapter({
      deviceId: "device-1",
      tokens: {
        operator: {
          role: "operator",
          scopes: ["operator.read"],
          token: "secret",
          updatedAtMs: 1,
        },
      },
      version: 1,
    });

    expect(
      loadDeviceAuthTokenFromStore({
        adapter,
        deviceId: "device-1",
        role: "  operator  ",
      }),
    ).toMatchObject({ token: "secret" });
    expect(
      loadDeviceAuthTokenFromStore({
        adapter,
        deviceId: "device-2",
        role: "operator",
      }),
    ).toBeNull();
  });

  it("returns null for missing stores and malformed token entries", () => {
    expect(
      loadDeviceAuthTokenFromStore({
        adapter: createAdapter().adapter,
        deviceId: "device-1",
        role: "operator",
      }),
    ).toBeNull();

    const { adapter } = createAdapter({
      deviceId: "device-1",
      tokens: {
        operator: {
          role: "operator",
          scopes: [],
          token: 123 as unknown as string,
          updatedAtMs: 1,
        },
      },
      version: 1,
    });
    expect(
      loadDeviceAuthTokenFromStore({
        adapter,
        deviceId: "device-1",
        role: "operator",
      }),
    ).toBeNull();
  });

  it("stores normalized roles and deduped sorted scopes while preserving same-device tokens", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const { adapter, writes, readStore } = createAdapter({
      deviceId: "device-1",
      tokens: {
        node: {
          role: "node",
          scopes: ["node.invoke"],
          token: "node-token",
          updatedAtMs: 10,
        },
      },
      version: 1,
    });

    const entry = storeDeviceAuthTokenInStore({
      adapter,
      deviceId: "device-1",
      role: "  operator ",
      scopes: [" operator.write ", "operator.read", "operator.read", ""],
      token: "operator-token",
    });

    expect(entry).toEqual({
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      token: "operator-token",
      updatedAtMs: 1234,
    });
    expect(writes).toHaveLength(1);
    expect(readStore()).toEqual({
      deviceId: "device-1",
      tokens: {
        node: {
          role: "node",
          scopes: ["node.invoke"],
          token: "node-token",
          updatedAtMs: 10,
        },
        operator: entry,
      },
      version: 1,
    });
  });

  it("replaces stale stores from other devices instead of merging them", () => {
    const { adapter, readStore } = createAdapter({
      deviceId: "device-2",
      tokens: {
        operator: {
          role: "operator",
          scopes: [],
          token: "old-token",
          updatedAtMs: 1,
        },
      },
      version: 1,
    });

    storeDeviceAuthTokenInStore({
      adapter,
      deviceId: "device-1",
      role: "node",
      token: "node-token",
    });

    expect(readStore()).toEqual({
      deviceId: "device-1",
      tokens: {
        node: {
          role: "node",
          scopes: [],
          token: "node-token",
          updatedAtMs: expect.any(Number),
        },
      },
      version: 1,
    });
  });

  it("overwrites existing entries for the same normalized role", () => {
    vi.spyOn(Date, "now").mockReturnValue(2222);
    const { adapter, readStore } = createAdapter({
      deviceId: "device-1",
      tokens: {
        operator: {
          role: "operator",
          scopes: ["operator.read"],
          token: "old-token",
          updatedAtMs: 10,
        },
      },
      version: 1,
    });

    const entry = storeDeviceAuthTokenInStore({
      adapter,
      deviceId: "device-1",
      role: " operator ",
      scopes: ["operator.write"],
      token: "new-token",
    });

    expect(entry).toEqual({
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      token: "new-token",
      updatedAtMs: 2222,
    });
    expect(readStore()).toEqual({
      deviceId: "device-1",
      tokens: {
        operator: entry,
      },
      version: 1,
    });
  });

  it("avoids writes when clearing missing roles or mismatched devices", () => {
    const missingRole = createAdapter({
      deviceId: "device-1",
      tokens: {},
      version: 1,
    });
    clearDeviceAuthTokenFromStore({
      adapter: missingRole.adapter,
      deviceId: "device-1",
      role: "operator",
    });
    expect(missingRole.writes).toHaveLength(0);

    const otherDevice = createAdapter({
      deviceId: "device-2",
      tokens: {
        operator: {
          role: "operator",
          scopes: [],
          token: "secret",
          updatedAtMs: 1,
        },
      },
      version: 1,
    });
    clearDeviceAuthTokenFromStore({
      adapter: otherDevice.adapter,
      deviceId: "device-1",
      role: "operator",
    });
    expect(otherDevice.writes).toHaveLength(0);
  });

  it("removes normalized roles when clearing stored tokens", () => {
    const { adapter, writes, readStore } = createAdapter({
      deviceId: "device-1",
      tokens: {
        node: {
          role: "node",
          scopes: [],
          token: "node-token",
          updatedAtMs: 2,
        },
        operator: {
          role: "operator",
          scopes: ["operator.read"],
          token: "secret",
          updatedAtMs: 1,
        },
      },
      version: 1,
    });

    clearDeviceAuthTokenFromStore({
      adapter,
      deviceId: "device-1",
      role: " operator ",
    });

    expect(writes).toHaveLength(1);
    expect(readStore()).toEqual({
      deviceId: "device-1",
      tokens: {
        node: {
          role: "node",
          scopes: [],
          token: "node-token",
          updatedAtMs: 2,
        },
      },
      version: 1,
    });
  });
});
