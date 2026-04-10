import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/plugins/directory.js";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { msteamsDirectoryAdapter } from "./directory.js";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";

function requireDirectorySelf(
  directory: typeof msteamsDirectoryAdapter | null | undefined,
): NonNullable<(typeof msteamsDirectoryAdapter)["self"]> {
  if (!directory?.self) {
    throw new Error("expected msteams directory.self");
  }
  return directory.self;
}

describe("msteams directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as RuntimeEnv;
  const directorySelf = requireDirectorySelf(msteamsDirectoryAdapter);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("self()", () => {
    it("returns bot identity when credentials are configured", async () => {
      const cfg = {
        channels: {
          msteams: {
            appId: "test-app-id-1234",
            appPassword: "secret",
            tenantId: "tenant-id-5678",
          },
        },
      } as unknown as OpenClawConfig;

      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toEqual({ id: "test-app-id-1234", kind: "user", name: "test-app-id-1234" });
    });

    it("returns null when credentials are not configured", async () => {
      vi.stubEnv("MSTEAMS_APP_ID", "");
      vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
      vi.stubEnv("MSTEAMS_TENANT_ID", "");
      const cfg = { channels: {} } as unknown as OpenClawConfig;
      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toBeNull();
    });
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["alice", "user:Bob"],
          dms: { bob: {}, carol: {} },
          teams: {
            team1: {
              channels: {
                chan2: {},
                "conversation:chan1": {},
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(msteamsDirectoryAdapter);

    await expect(
      directory.listPeers({
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "user:alice", kind: "user" },
        { id: "user:Bob", kind: "user" },
        { id: "user:carol", kind: "user" },
        { id: "user:bob", kind: "user" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "conversation:chan1", kind: "group" },
        { id: "conversation:chan2", kind: "group" },
      ]),
    );
  });

  it("normalizes spaced allowlist and dm entries", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["  user:Bob  ", "  Alice  "],
          dms: { "  Carol  ": {}, "user:Dave": {} },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(msteamsDirectoryAdapter);

    await expect(
      directory.listPeers({
        cfg,
        limit: undefined,
        query: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: "user:Bob", kind: "user" },
        { id: "user:Alice", kind: "user" },
        { id: "user:Carol", kind: "user" },
        { id: "user:Dave", kind: "user" },
      ]),
    );
  });
});

describe("msteams session route", () => {
  it("builds direct routes for explicit user targets", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      accountId: "default",
      agentId: "main",
      cfg: {},
      target: "msteams:user:alice-id",
    });

    expect(route).toMatchObject({
      from: "msteams:alice-id",
      peer: {
        id: "alice-id",
        kind: "direct",
      },
      to: "user:alice-id",
    });
  });

  it("builds channel routes for thread conversations and strips suffix metadata", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      accountId: "default",
      agentId: "main",
      cfg: {},
      target: "teams:19:abc123@thread.tacv2;messageid=42",
    });

    expect(route).toMatchObject({
      from: "msteams:channel:19:abc123@thread.tacv2",
      peer: {
        id: "19:abc123@thread.tacv2",
        kind: "channel",
      },
      to: "conversation:19:abc123@thread.tacv2",
    });
  });

  it("returns group routes for non-user, non-channel conversations", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      accountId: "default",
      agentId: "main",
      cfg: {},
      target: "msteams:conversation:19:groupchat",
    });

    expect(route).toMatchObject({
      from: "msteams:group:19:groupchat",
      peer: {
        id: "19:groupchat",
        kind: "group",
      },
      to: "conversation:19:groupchat",
    });
  });

  it("returns null when the target cannot be normalized", () => {
    expect(
      resolveMSTeamsOutboundSessionRoute({
        accountId: "default",
        agentId: "main",
        cfg: {},
        target: "msteams:",
      }),
    ).toBeNull();
  });
});
