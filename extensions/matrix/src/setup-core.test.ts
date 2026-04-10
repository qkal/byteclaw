import { describe, expect, it } from "vitest";
import { matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

function applyOpsAccountConfig(cfg: CoreConfig): CoreConfig {
  return matrixSetupAdapter.applyAccountConfig({
    accountId: "ops",
    cfg,
    input: {
      accessToken: "ops-token",
      homeserver: "https://matrix.example.org",
      name: "Ops",
    },
  }) as CoreConfig;
}

function expectPromotedDefaultAccount(next: CoreConfig): void {
  expect(next.channels?.matrix?.accounts?.Default).toMatchObject({
    accessToken: "default-token",
    avatarUrl: "mxc://example.org/default-avatar",
    deviceName: "Legacy raw key",
    enabled: true,
    homeserver: "https://matrix.example.org",
    userId: "@default:example.org",
  });
  expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
}

function expectOpsAccount(next: CoreConfig): void {
  expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
    accessToken: "ops-token",
    enabled: true,
    homeserver: "https://matrix.example.org",
    name: "Ops",
  });
}

describe("matrixSetupAdapter", () => {
  it("moves legacy default config before writing a named account", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "default-token",
          deviceName: "Default device",
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      accountId: "ops",
      cfg,
      input: {
        accessToken: "ops-token",
        homeserver: "https://matrix.example.org",
        name: "Ops",
        userId: "@ops:example.org",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.default).toMatchObject({
      accessToken: "default-token",
      deviceName: "Default device",
      homeserver: "https://matrix.example.org",
      userId: "@default:example.org",
    });
    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      enabled: true,
      homeserver: "https://matrix.example.org",
      name: "Ops",
      userId: "@ops:example.org",
    });
  });

  it("reuses an existing raw default-account key during promotion", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "default-token",
          accounts: {
            Default: {
              deviceName: "Legacy raw key",
              enabled: true,
            },
          },
          avatarUrl: "mxc://example.org/default-avatar",
          defaultAccount: "default",
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
        },
      },
    } as CoreConfig;

    const next = applyOpsAccountConfig(cfg);

    expectPromotedDefaultAccount(next);
    expectOpsAccount(next);
  });

  it("reuses an existing raw default-like key during promotion when defaultAccount is unset", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "default-token",
          accounts: {
            Default: {
              deviceName: "Legacy raw key",
              enabled: true,
            },
            support: {
              accessToken: "support-token",
              homeserver: "https://matrix.example.org",
            },
          },
          avatarUrl: "mxc://example.org/default-avatar",
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
        },
      },
    } as CoreConfig;

    const next = applyOpsAccountConfig(cfg);

    expectPromotedDefaultAccount(next);
    expect(next.channels?.matrix?.accounts?.support).toMatchObject({
      accessToken: "support-token",
      homeserver: "https://matrix.example.org",
    });
    expectOpsAccount(next);
  });

  it("clears stored auth fields when switching an account to env-backed auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              deviceId: "DEVICE",
              deviceName: "Ops device",
              homeserver: "https://matrix.example.org",
              name: "Ops",
              password: "secret",
              proxy: "http://127.0.0.1:7890",
              userId: "@ops:example.org",
            },
          },
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      accountId: "ops",
      cfg,
      input: {
        name: "Ops",
        useEnv: true,
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      enabled: true,
      name: "Ops",
    });
    expect(next.channels?.matrix?.accounts?.ops?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.proxy).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.accessToken).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.password).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.deviceId).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.deviceName).toBeUndefined();
  });

  it("keeps avatarUrl when switching an account to env-backed auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.example.org",
              name: "Ops",
            },
          },
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      accountId: "ops",
      cfg,
      input: {
        avatarUrl: "  mxc://example.org/ops-avatar  ",
        name: "Ops",
        useEnv: true,
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      avatarUrl: "mxc://example.org/ops-avatar",
      enabled: true,
      name: "Ops",
    });
    expect(next.channels?.matrix?.accounts?.ops?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.accessToken).toBeUndefined();
  });

  it("stores proxy in account setup updates", () => {
    const next = matrixSetupAdapter.applyAccountConfig({
      accountId: "ops",
      cfg: {} as CoreConfig,
      input: {
        accessToken: "ops-token",
        homeserver: "https://matrix.example.org",
        proxy: "http://127.0.0.1:7890",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      enabled: true,
      homeserver: "https://matrix.example.org",
      proxy: "http://127.0.0.1:7890",
    });
  });

  it("stores avatarUrl from setup input on the target account", () => {
    const next = matrixSetupAdapter.applyAccountConfig({
      accountId: "ops",
      cfg: {} as CoreConfig,
      input: {
        accessToken: "ops-token",
        avatarUrl: "  mxc://example.org/ops-avatar  ",
        homeserver: "https://matrix.example.org",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      avatarUrl: "mxc://example.org/ops-avatar",
      enabled: true,
      homeserver: "https://matrix.example.org",
    });
  });

  it("rejects unsupported avatar URL schemes during setup validation", () => {
    const validationError = matrixSetupAdapter.validateInput?.({
      accountId: "ops",
      cfg: {} as CoreConfig,
      input: {
        accessToken: "ops-token",
        avatarUrl: "file:///tmp/avatar.png",
        homeserver: "https://matrix.example.org",
      },
    });

    expect(validationError).toBe("Matrix avatar URL must be an mxc:// URI or an http(s) URL.");
  });

  it("stores canonical dangerous private-network opt-in from setup input", () => {
    const next = matrixSetupAdapter.applyAccountConfig({
      accountId: "ops",
      cfg: {} as CoreConfig,
      input: {
        accessToken: "ops-token",
        dangerouslyAllowPrivateNetwork: true,
        homeserver: "http://matrix.internal:8008",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      enabled: true,
      homeserver: "http://matrix.internal:8008",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  it("keeps top-level block streaming as a shared default when named accounts already exist", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "default-token",
          accounts: {
            support: {
              accessToken: "support-token",
              homeserver: "https://matrix.example.org",
              userId: "@support:example.org",
            },
          },
          blockStreaming: true,
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      accountId: "ops",
      cfg,
      input: {
        accessToken: "ops-token",
        homeserver: "https://matrix.example.org",
        name: "Ops",
        userId: "@ops:example.org",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.blockStreaming).toBe(true);
    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      enabled: true,
      homeserver: "https://matrix.example.org",
      name: "Ops",
      userId: "@ops:example.org",
    });
    expect(next.channels?.matrix?.accounts?.ops?.blockStreaming).toBeUndefined();
  });
});
