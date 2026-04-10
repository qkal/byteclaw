import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi, PluginRuntime } from "../runtime-api.js";

const createFeishuToolClientMock = vi.hoisted(() => vi.fn());
const resolveAnyEnabledFeishuToolsConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
  resolveAnyEnabledFeishuToolsConfig: resolveAnyEnabledFeishuToolsConfigMock,
}));

let registerFeishuDriveTools: typeof import("./drive.js").registerFeishuDriveTools;

function createFeishuToolRuntime(): PluginRuntime {
  return {} as PluginRuntime;
}

function createDriveToolApi(params: {
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

describe("registerFeishuDriveTools", () => {
  const requestMock = vi.fn();

  beforeAll(async () => {
    ({ registerFeishuDriveTools } = await import("./drive.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveAnyEnabledFeishuToolsConfigMock.mockReturnValue({
      chat: false,
      doc: false,
      drive: true,
      perm: false,
      scopes: false,
      wiki: false,
    });
    createFeishuToolClientMock.mockReturnValue({
      request: requestMock,
    });
  });

  it("registers feishu_drive and handles comment actions", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });
    expect(tool?.name).toBe("feishu_drive");

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            comment_id: "c1",
            quote: "quoted text",
            reply_list: {
              replies: [
                {
                  content: {
                    elements: [
                      {
                        type: "text_run",
                        text_run: { text: "root comment" },
                      },
                    ],
                  },
                  reply_id: "r1",
                  user_id: "ou_author",
                },
                {
                  content: {
                    elements: [
                      {
                        type: "text_run",
                        text_run: { text: "reply text" },
                      },
                    ],
                  },
                  reply_id: "r2",
                  user_id: "ou_reply",
                },
              ],
            },
          },
        ],
        page_token: "0",
      },
    });
    const listResult = await tool.execute("call-1", {
      action: "list_comments",
      file_token: "doc_1",
      file_type: "docx",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(listResult.details).toEqual(
      expect.objectContaining({
        comments: [
          expect.objectContaining({
            comment_id: "c1",
            quote: "quoted text",
            replies: [expect.objectContaining({ reply_id: "r2", text: "reply text" })],
            text: "root comment",
          }),
        ],
      }),
    );

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            content: {
              elements: [
                {
                  type: "text_run",
                  text_run: { content: "reply from api" },
                },
              ],
            },
            reply_id: "r3",
            user_id: "ou_reply_2",
          },
        ],
        page_token: "0",
      },
    });
    const repliesResult = await tool.execute("call-2", {
      action: "list_comment_replies",
      comment_id: "c1",
      file_token: "doc_1",
      file_type: "docx",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(repliesResult.details).toEqual(
      expect.objectContaining({
        replies: [expect.objectContaining({ reply_id: "r3", text: "reply from api" })],
      }),
    );

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c2" },
    });
    const addCommentResult = await tool.execute("call-3", {
      action: "add_comment",
      block_id: "blk_1",
      content: "please update this section",
      file_token: "doc_1",
      file_type: "docx",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: {
          anchor: { block_id: "blk_1" },
          file_type: "docx",
          reply_elements: [{ text: "please update this section", type: "text" }],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
      }),
    );
    expect(addCommentResult.details).toEqual(
      expect.objectContaining({ comment_id: "c2", success: true }),
    );

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r4" },
      });
    const replyCommentResult = await tool.execute("call-4", {
      action: "reply_comment",
      comment_id: "c1",
      content: "handled",
      file_token: "doc_1",
      file_type: "docx",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        data: {
          comment_ids: ["c1"],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        data: {
          content: {
            elements: [
              {
                text_run: {
                  text: "handled",
                },
                type: "text_run",
              },
            ],
          },
        },
        method: "POST",
        params: { file_type: "docx" },
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
      }),
    );
    expect(replyCommentResult.details).toEqual(
      expect.objectContaining({ reply_id: "r4", success: true }),
    );
  });

  it("defaults add_comment file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c-default-docx" },
    });

    const result = await tool.execute("call-default-docx", {
      action: "add_comment",
      content: "defaulted file type",
      file_token: "doc_1",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          file_type: "docx",
          reply_elements: [{ text: "defaulted file type", type: "text" }],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("add_comment missing file_type; defaulting to docx"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({ comment_id: "c-default-docx", success: true }),
    );
  });

  it("defaults list_comments file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, items: [] },
    });

    await tool.execute("call-list-default-docx", {
      action: "list_comments",
      file_token: "doc_1",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("list_comments missing file_type; defaulting to docx"),
    );
  });

  it("defaults list_comment_replies file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, items: [] },
    });

    await tool.execute("call-replies-default-docx", {
      action: "list_comment_replies",
      comment_id: "c1",
      file_token: "doc_1",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("list_comment_replies missing file_type; defaulting to docx"),
    );
  });

  it("surfaces reply_comment HTTP errors when the single supported body fails", async () => {
    const registerTool = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockRejectedValueOnce({
        code: "ERR_BAD_REQUEST",
        config: {
          method: "post",
          params: { file_type: "docx" },
          url: "https://open.feishu.cn/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        },
        message: "Request failed with status code 400",
        response: {
          data: {
            code: 99_992_402,
            log_id: "log_legacy_400",
            msg: "field validation failed",
          },
          status: 400,
        },
      });

    const replyCommentResult = await tool.execute("call-throw", {
      action: "reply_comment",
      comment_id: "c1",
      content: "inserted successfully",
      file_token: "doc_1",
      file_type: "docx",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          comment_ids: ["c1"],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          content: {
            elements: [
              {
                text_run: {
                  text: "inserted successfully",
                },
                type: "text_run",
              },
            ],
          },
        },
        method: "POST",
        params: { file_type: "docx" },
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("replyComment threw"));
    expect(replyCommentResult.details).toEqual(
      expect.objectContaining({ error: "Request failed with status code 400" }),
    );
  });

  it("defaults reply_comment target fields from the ambient Feishu comment delivery context", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({
      agentAccountId: undefined,
      deliveryContext: {
        channel: "feishu",
        to: "comment:docx:doc_1:c1",
      },
    });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r6" },
      });

    const replyCommentResult = await tool.execute("call-ambient", {
      action: "reply_comment",
      content: "ambient success",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          comment_ids: ["c1"],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          content: {
            elements: [
              {
                text_run: {
                  text: "ambient success",
                },
                type: "text_run",
              },
            ],
          },
        },
        method: "POST",
        params: { file_type: "docx" },
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
      }),
    );
    expect(replyCommentResult.details).toEqual(
      expect.objectContaining({ reply_id: "r6", success: true }),
    );
  });

  it("does not inherit non-doc ambient file types for add_comment", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({
      agentAccountId: undefined,
      deliveryContext: {
        channel: "feishu",
        to: "comment:sheet:sheet_1:c1",
      },
    });

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c-add-docx" },
    });

    const result = await tool.execute("call-add-ignore-sheet-ambient", {
      action: "add_comment",
      content: "default add comment",
      file_token: "doc_1",
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          file_type: "docx",
          reply_elements: [{ text: "default add comment", type: "text" }],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("add_comment missing file_type; defaulting to docx"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({ comment_id: "c-add-docx", success: true }),
    );
  });

  it("defaults reply_comment file_type to docx when omitted", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r-default-docx" },
      });

    const result = await tool.execute("call-reply-default-docx", {
      action: "reply_comment",
      comment_id: "c1",
      content: "default reply docx",
      file_token: "doc_1",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: { comment_ids: ["c1"] },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          content: {
            elements: [
              {
                text_run: {
                  text: "default reply docx",
                },
                type: "text_run",
              },
            ],
          },
        },
        method: "POST",
        params: { file_type: "docx" },
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("reply_comment missing file_type; defaulting to docx"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({ reply_id: "r-default-docx", success: true }),
    );
  });

  it("routes whole-document reply_comment requests through add_comment compatibility", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: true }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { comment_id: "c2" },
      });

    const result = await tool.execute("call-whole", {
      action: "reply_comment",
      comment_id: "c1",
      content: "whole comment follow-up",
      file_token: "doc_1",
      file_type: "docx",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          comment_ids: ["c1"],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          file_type: "docx",
          reply_elements: [{ text: "whole comment follow-up", type: "text" }],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("whole-comment compatibility path"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        comment_id: "c2",
        delivery_mode: "add_comment",
        success: true,
      }),
    );
  });

  it("continues with reply_comment when comment metadata preflight fails", async () => {
    const registerTool = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockRejectedValueOnce(new Error("preflight unavailable")).mockResolvedValueOnce({
      code: 0,
      data: { reply_id: "r-preflight-fallback" },
    });

    const result = await tool.execute("call-preflight-fallback", {
      action: "reply_comment",
      comment_id: "c1",
      content: "preflight fallback reply",
      file_token: "doc_1",
      file_type: "docx",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          comment_ids: ["c1"],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          content: {
            elements: [
              {
                text_run: {
                  text: "preflight fallback reply",
                },
                type: "text_run",
              },
            ],
          },
        },
        method: "POST",
        params: { file_type: "docx" },
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("comment metadata preflight failed"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        delivery_mode: "reply_comment",
        reply_id: "r-preflight-fallback",
        success: true,
      }),
    );
  });

  it("continues with reply_comment when batch_query returns no exact comment match", async () => {
    const registerTool = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "different_comment", is_whole: true }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r-no-exact-match" },
      });

    const result = await tool.execute("call-preflight-no-exact-match", {
      action: "reply_comment",
      comment_id: "c1",
      content: "fallback on exact match miss",
      file_token: "doc_1",
      file_type: "docx",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          comment_ids: ["c1"],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/batch_query?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          content: {
            elements: [
              {
                text_run: {
                  text: "fallback on exact match miss",
                },
                type: "text_run",
              },
            ],
          },
        },
        method: "POST",
        params: { file_type: "docx" },
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies",
      }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("whole-comment compatibility path"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        delivery_mode: "reply_comment",
        reply_id: "r-no-exact-match",
        success: true,
      }),
    );
  });

  it("falls back to add_comment when reply_comment returns compatibility code 1069302 even without is_whole metadata", async () => {
    const registerTool = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ comment_id: "c1", is_whole: false }],
        },
      })
      .mockRejectedValueOnce({
        code: "ERR_BAD_REQUEST",
        config: {
          method: "post",
          params: { file_type: "docx" },
          url: "https://open.feishu.cn/open-apis/drive/v1/files/doc_1/comments/c1/replies",
        },
        message: "Request failed with status code 400",
        response: {
          data: {
            code: 1_069_302,
            log_id: "log_reply_forbidden",
            msg: "param error",
          },
          status: 400,
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { comment_id: "c3" },
      });

    const result = await tool.execute("call-reply-forbidden", {
      action: "reply_comment",
      comment_id: "c1",
      content: "compat follow-up",
      file_token: "doc_1",
      file_type: "docx",
    });

    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: {
          file_type: "docx",
          reply_elements: [{ text: "compat follow-up", type: "text" }],
        },
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("reply-not-allowed compatibility path"),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        comment_id: "c3",
        delivery_mode: "add_comment",
        success: true,
      }),
    );
  });

  it("clamps comment list page sizes to the Feishu API maximum", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });

    requestMock.mockResolvedValueOnce({ code: 0, data: { has_more: false, items: [] } });
    await tool.execute("call-list", {
      action: "list_comments",
      file_token: "doc_1",
      file_type: "docx",
      page_size: 200,
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments?file_type=docx&page_size=100&user_id_type=open_id",
      }),
    );

    requestMock.mockResolvedValueOnce({ code: 0, data: { has_more: false, items: [] } });
    await tool.execute("call-replies", {
      action: "list_comment_replies",
      comment_id: "c1",
      file_token: "doc_1",
      file_type: "docx",
      page_size: 200,
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx&page_size=100&user_id_type=open_id",
      }),
    );
  });

  it("rejects block-scoped comments for non-docx files", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // Pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });
    const result = await tool.execute("call-5", {
      action: "add_comment",
      block_id: "blk_1",
      content: "invalid",
      file_token: "doc_1",
      file_type: "doc",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        error: "block_id is only supported for docx comments",
      }),
    );
  });
});
