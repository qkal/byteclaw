import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./config-update.js";

describe("updateMatrixAccountConfig", () => {
  it("resolves account-aware Matrix config field paths", () => {
    expect(resolveMatrixConfigFieldPath({} as CoreConfig, "default", "dm.policy")).toBe(
      "channels.matrix.dm.policy",
    );

    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixConfigFieldPath(cfg, "ops", ".dm.allowFrom")).toBe(
      "channels.matrix.accounts.ops.dm.allowFrom",
    );
  });

  it("supports explicit null clears and boolean false values", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "old-token", // Pragma: allowlist secret
              password: "old-password", // Pragma: allowlist secret
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "default", {
      accessToken: "new-token",
      encryption: false,
      password: null,
      userId: null,
    });

    expect(updated.channels?.["matrix"]?.accounts?.default).toMatchObject({
      accessToken: "new-token",
      encryption: false,
    });
    expect(updated.channels?.["matrix"]?.accounts?.default?.password).toBeUndefined();
    expect(updated.channels?.["matrix"]?.accounts?.default?.userId).toBeUndefined();
  });

  it("preserves SecretRef auth inputs when updating config", () => {
    const updated = updateMatrixAccountConfig({} as CoreConfig, "default", {
      accessToken: { id: "MATRIX_ACCESS_TOKEN", provider: "default", source: "env" },
      password: { id: "MATRIX_PASSWORD", provider: "default", source: "env" },
    });

    expect(updated.channels?.matrix?.accessToken).toEqual({
      id: "MATRIX_ACCESS_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(updated.channels?.matrix?.password).toEqual({
      id: "MATRIX_PASSWORD",
      provider: "default",
      source: "env",
    });
  });

  it("stores and clears Matrix allowBots, allowPrivateNetwork, and proxy settings", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              allowBots: true,
              network: {
                dangerouslyAllowPrivateNetwork: true,
              },
              proxy: "http://127.0.0.1:7890",
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "default", {
      allowBots: "mentions",
      allowPrivateNetwork: null,
      proxy: null,
    });

    expect(updated.channels?.["matrix"]?.accounts?.default).toMatchObject({
      allowBots: "mentions",
    });
    expect(updated.channels?.["matrix"]?.accounts?.default?.network).toBeUndefined();
    expect(updated.channels?.["matrix"]?.accounts?.default?.proxy).toBeUndefined();
  });

  it("stores and clears Matrix invite auto-join settings", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              autoJoin: "allowlist",
              autoJoinAllowlist: ["#ops:example.org"],
            },
          },
        },
      },
    } as CoreConfig;

    const allowlistUpdated = updateMatrixAccountConfig(cfg, "default", {
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops-room:example.org", "#ops:example.org"],
    });
    expect(allowlistUpdated.channels?.matrix?.accounts?.default).toMatchObject({
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops-room:example.org", "#ops:example.org"],
    });

    const offUpdated = updateMatrixAccountConfig(cfg, "default", {
      autoJoin: "off",
      autoJoinAllowlist: null,
    });
    expect(offUpdated.channels?.matrix?.accounts?.default?.autoJoin).toBe("off");
    expect(offUpdated.channels?.matrix?.accounts?.default?.autoJoinAllowlist).toBeUndefined();

    const alwaysUpdated = updateMatrixAccountConfig(cfg, "default", {
      autoJoin: "always",
      autoJoinAllowlist: null,
    });
    expect(alwaysUpdated.channels?.matrix?.accounts?.default?.autoJoin).toBe("always");
    expect(alwaysUpdated.channels?.matrix?.accounts?.default?.autoJoinAllowlist).toBeUndefined();
  });

  it("normalizes account id and defaults account enabled=true", () => {
    const updated = updateMatrixAccountConfig({} as CoreConfig, "Main Bot", {
      homeserver: "https://matrix.example.org",
      name: "Main Bot",
    });

    expect(updated.channels?.["matrix"]?.accounts?.["main-bot"]).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      name: "Main Bot",
    });
  });

  it("updates nested access config for named accounts without touching top-level defaults", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              accessToken: "ops-token",
              dm: {
                enabled: true,
                policy: "pairing",
              },
              homeserver: "https://matrix.ops.example.org",
            },
          },
          dm: {
            policy: "pairing",
          },
          groups: {
            "!default:example.org": { enabled: true },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      dm: {
        allowFrom: ["@alice:example.org"],
        policy: "allowlist",
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { enabled: true },
      },
      rooms: null,
    });

    expect(updated.channels?.["matrix"]?.dm?.policy).toBe("pairing");
    expect(updated.channels?.["matrix"]?.groups).toEqual({
      "!default:example.org": { enabled: true },
    });
    expect(updated.channels?.["matrix"]?.accounts?.ops).toMatchObject({
      dm: {
        allowFrom: ["@alice:example.org"],
        enabled: true,
        policy: "allowlist",
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { enabled: true },
      },
    });
    expect(updated.channels?.["matrix"]?.accounts?.ops?.rooms).toBeUndefined();
  });

  it("reuses and canonicalizes non-normalized account entries when updating", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            Ops: {
              accessToken: "ops-token",
              homeserver: "https://matrix.ops.example.org",
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      deviceName: "Ops Bot",
    });

    expect(updated.channels?.["matrix"]?.accounts?.Ops).toBeUndefined();
    expect(updated.channels?.["matrix"]?.accounts?.ops).toMatchObject({
      accessToken: "ops-token",
      deviceName: "Ops Bot",
      enabled: true,
      homeserver: "https://matrix.ops.example.org",
    });
  });
});
