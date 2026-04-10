import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi, PluginRuntime } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const chatGetMock = vi.hoisted(() => vi.fn());
const chatMembersGetMock = vi.hoisted(() => vi.fn());
const contactUserGetMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

let registerFeishuChatTools: typeof import("./chat.js").registerFeishuChatTools;

function createFeishuToolRuntime(): PluginRuntime {
  return {} as PluginRuntime;
}

describe("registerFeishuChatTools", () => {
  function createChatToolApi(params: {
    config: OpenClawPluginApi["config"];
    registerTool: OpenClawPluginApi["registerTool"];
  }): OpenClawPluginApi {
    return createTestPluginApi({
      config: params.config,
      id: "feishu-test",
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      name: "Feishu Test",
      registerTool: params.registerTool,
      runtime: createFeishuToolRuntime(),
      source: "local",
    });
  }

  beforeAll(async () => {
    ({ registerFeishuChatTools } = await import("./chat.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      contact: {
        user: { get: contactUserGetMock },
      },
      im: {
        chat: { get: chatGetMock },
        chatMembers: { get: chatMembersGetMock },
      },
    });
  });

  it("registers feishu_chat and handles info/members actions", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { chat: true },
            },
          },
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool?.name).toBe("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
    expect(infoResult.details).toEqual(
      expect.objectContaining({ chat_id: "oc_1", name: "group name", user_count: 3 }),
    );

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        items: [{ member_id: "ou_1", member_id_type: "open_id", name: "member1" }],
        page_token: "",
      },
    });
    const membersResult = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );

    contactUserGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        user: {
          department_ids: ["od_1"],
          email: "member1@example.com",
          name: "member1",
          open_id: "ou_1",
        },
      },
    });
    const memberInfoResult = await tool.execute("tc_3", {
      action: "member_info",
      member_id: "ou_1",
    });
    expect(memberInfoResult.details).toEqual(
      expect.objectContaining({
        department_ids: ["od_1"],
        email: "member1@example.com",
        member_id: "ou_1",
        name: "member1",
        open_id: "ou_1",
      }),
    );
  });

  it("skips registration when chat tool is disabled", () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { chat: false },
            },
          },
        },
        registerTool,
      }),
    );
    expect(registerTool).not.toHaveBeenCalled();
  });
});
