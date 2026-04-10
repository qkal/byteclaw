import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const freshDirectoryModulePath = "./directory.js?directory-test";
const {
  listFeishuDirectoryGroups,
  listFeishuDirectoryGroupsLive,
  listFeishuDirectoryPeers,
  listFeishuDirectoryPeersLive,
} = await import(freshDirectoryModulePath);

function makeStaticCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        allowFrom: ["user:alice", "user:bob"],
        dms: {
          "user:carla": {},
        },
        groupAllowFrom: ["chat-2"],
        groups: {
          "chat-1": {},
        },
      },
    },
  } as ClawdbotConfig;
}

function makeConfiguredCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        ...makeStaticCfg().channels?.feishu,
        appId: "cli_test_app_id",
        appSecret: "cli_test_app_secret",
      },
    },
  } as ClawdbotConfig;
}

describe("feishu directory (config-backed)", () => {
  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it("merges allowFrom + dms into peer entries", async () => {
    const peers = await listFeishuDirectoryPeers({ cfg: makeStaticCfg(), query: "a" });
    expect(peers).toEqual([
      { id: "alice", kind: "user" },
      { id: "carla", kind: "user" },
    ]);
  });

  it("normalizes spaced provider-prefixed peer entries", async () => {
    const cfg = {
      channels: {
        feishu: {
          allowFrom: [" feishu:user:ou_alice "],
          dms: {
            " lark:dm:ou_carla ": {},
          },
          groupAllowFrom: [],
          groups: {},
        },
      },
    } as ClawdbotConfig;

    const peers = await listFeishuDirectoryPeers({ cfg });
    expect(peers).toEqual([
      { id: "ou_alice", kind: "user" },
      { id: "ou_carla", kind: "user" },
    ]);
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    const groups = await listFeishuDirectoryGroups({ cfg: makeStaticCfg() });
    expect(groups).toEqual([
      { id: "chat-1", kind: "group" },
      { id: "chat-2", kind: "group" },
    ]);
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    const peers = await listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), query: "a" });
    expect(peers).toEqual([
      { id: "alice", kind: "user" },
      { id: "carla", kind: "user" },
    ]);
  });

  it("surfaces live peer lookup failures when fallback is disabled", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("token expired");
  });

  it("surfaces live group lookup failures when fallback is disabled", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          list: vi.fn(async () => ({ code: 999, msg: "forbidden" })),
        },
      },
    });

    await expect(
      listFeishuDirectoryGroupsLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("forbidden");
  });
});
