import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { buildMarkdownCard } from "./send.js";

const {
  mockConvertMarkdownTables,
  mockClientGet,
  mockClientList,
  mockClientPatch,
  mockCreateFeishuClient,
  mockResolveMarkdownTableMode,
  mockResolveFeishuAccount,
  mockRuntimeConvertMarkdownTables,
  mockRuntimeResolveMarkdownTableMode,
} = vi.hoisted(() => ({
  mockClientGet: vi.fn(),
  mockClientList: vi.fn(),
  mockClientPatch: vi.fn(),
  mockConvertMarkdownTables: vi.fn((text: string) => text),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
  mockResolveMarkdownTableMode: vi.fn(() => "preserve"),
  mockRuntimeConvertMarkdownTables: vi.fn((text: string) => text),
  mockRuntimeResolveMarkdownTableMode: vi.fn(() => "preserve"),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  resolveMarkdownTableMode: mockResolveMarkdownTableMode,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-runtime")>();
  return {
    ...actual,
    convertMarkdownTables: mockConvertMarkdownTables,
  };
});

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
  resolveFeishuRuntimeAccount: mockResolveFeishuAccount,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        convertMarkdownTables: mockRuntimeConvertMarkdownTables,
        resolveMarkdownTableMode: mockRuntimeResolveMarkdownTableMode,
      },
    },
  }),
}));

let buildStructuredCard: typeof import("./send.js").buildStructuredCard;
let editMessageFeishu: typeof import("./send.js").editMessageFeishu;
let getMessageFeishu: typeof import("./send.js").getMessageFeishu;
let listFeishuThreadMessages: typeof import("./send.js").listFeishuThreadMessages;
let resolveFeishuCardTemplate: typeof import("./send.js").resolveFeishuCardTemplate;
let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;

describe("getMessageFeishu", () => {
  beforeAll(async () => {
    ({
      buildStructuredCard,
      editMessageFeishu,
      getMessageFeishu,
      listFeishuThreadMessages,
      resolveFeishuCardTemplate,
      sendMessageFeishu,
    } = await import("./send.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMarkdownTableMode.mockReturnValue("preserve");
    mockConvertMarkdownTables.mockImplementation((text: string) => text);
    mockRuntimeResolveMarkdownTableMode.mockReturnValue("preserve");
    mockRuntimeConvertMarkdownTables.mockImplementation((text: string) => text);
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create: vi.fn(),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
        },
      },
    });
  });

  it("sends text without requiring Feishu runtime text helpers", async () => {
    mockRuntimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockRuntimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockClientPatch.mockResolvedValueOnce({ code: 0 });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_send" } }),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
          reply: vi.fn(),
        },
      },
    });

    const result = await sendMessageFeishu({
      cfg: {} as ClawdbotConfig,
      text: "hello",
      to: "oc_send",
    });

    expect(mockResolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg: {},
      channel: "feishu",
    });
    expect(mockConvertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
    expect(result).toEqual({ chatId: "oc_send", messageId: "om_send" });
  });

  it("extracts text content from interactive card elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            body: {
              content: JSON.stringify({
                elements: [
                  { content: "hello markdown", tag: "markdown" },
                  { tag: "div", text: { content: "hello div" } },
                ],
              }),
            },
            chat_id: "oc_1",
            message_id: "om_1",
            msg_type: "interactive",
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
    });

    expect(result).toEqual(
      expect.objectContaining({
        chatId: "oc_1",
        content: "hello markdown\nhello div",
        contentType: "interactive",
        messageId: "om_1",
      }),
    );
  });

  it("extracts text content from post messages", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            body: {
              content: JSON.stringify({
                zh_cn: {
                  content: [[{ tag: "text", text: "post body" }]],
                  title: "Summary",
                },
              }),
            },
            chat_id: "oc_post",
            message_id: "om_post",
            msg_type: "post",
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post",
    });

    expect(result).toEqual(
      expect.objectContaining({
        chatId: "oc_post",
        content: "Summary\n\npost body",
        contentType: "post",
        messageId: "om_post",
      }),
    );
  });

  it("returns text placeholder instead of raw JSON for unsupported message types", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
            chat_id: "oc_file",
            message_id: "om_file",
            msg_type: "file",
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_file",
    });

    expect(result).toEqual(
      expect.objectContaining({
        chatId: "oc_file",
        content: "[file message]",
        contentType: "file",
        messageId: "om_file",
      }),
    );
  });

  it("supports single-object response shape from Feishu API", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        body: {
          content: JSON.stringify({ text: "single payload" }),
        },
        chat_id: "oc_single",
        message_id: "om_single",
        msg_type: "text",
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_single",
    });

    expect(result).toEqual(
      expect.objectContaining({
        chatId: "oc_single",
        content: "single payload",
        contentType: "text",
        messageId: "om_single",
      }),
    );
  });

  it("reuses the same content parsing for thread history messages", async () => {
    mockClientList.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            body: {
              content: JSON.stringify({ text: "root starter" }),
            },
            message_id: "om_root",
            msg_type: "text",
          },
          {
            body: {
              content: JSON.stringify({
                body: {
                  elements: [{ content: "hello from card 2.0", tag: "markdown" }],
                },
              }),
            },
            create_time: "1710000000000",
            message_id: "om_card",
            msg_type: "interactive",
            sender: {
              id: "app_1",
              sender_type: "app",
            },
          },
          {
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
            create_time: "1710000001000",
            message_id: "om_file",
            msg_type: "file",
            sender: {
              id: "ou_1",
              sender_type: "user",
            },
          },
        ],
      },
    });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      rootMessageId: "om_root",
      threadId: "omt_1",
    });

    expect(result).toEqual([
      expect.objectContaining({
        content: "[file message]",
        contentType: "file",
        messageId: "om_file",
      }),
      expect.objectContaining({
        content: "hello from card 2.0",
        contentType: "interactive",
        messageId: "om_card",
      }),
    ]);
  });
});

describe("editMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          patch: mockClientPatch,
        },
      },
    });
  });

  it("patches post content for text edits", async () => {
    mockRuntimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockRuntimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit",
      text: "updated body",
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      data: {
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                {
                  tag: "md",
                  text: "updated body",
                },
              ],
            ],
          },
        }),
      },
      path: { message_id: "om_edit" },
    });
    expect(result).toEqual({ contentType: "post", messageId: "om_edit" });
  });

  it("patches interactive content for card edits", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    const result = await editMessageFeishu({
      card: { schema: "2.0" },
      cfg: {} as ClawdbotConfig,
      messageId: "om_card",
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      data: {
        content: JSON.stringify({ schema: "2.0" }),
      },
      path: { message_id: "om_card" },
    });
    expect(result).toEqual({ contentType: "interactive", messageId: "om_card" });
  });
});

describe("resolveFeishuCardTemplate", () => {
  it("accepts supported Feishu templates", () => {
    expect(resolveFeishuCardTemplate(" purple ")).toBe("purple");
  });

  it("drops unsupported free-form identity themes", () => {
    expect(resolveFeishuCardTemplate("space lobster")).toBeUndefined();
  });
});

describe("buildStructuredCard", () => {
  it("uses schema-2.0 width config instead of legacy wide screen mode", () => {
    const card = buildStructuredCard("hello") as {
      config: {
        width_mode?: string;
        enable_forward?: boolean;
        wide_screen_mode?: boolean;
      };
    };

    expect(card.config.width_mode).toBe("fill");
    expect(card.config.enable_forward).toBeUndefined();
    expect(card.config.wide_screen_mode).toBeUndefined();
  });

  it("falls back to blue when the header template is unsupported", () => {
    const card = buildStructuredCard("hello", {
      header: {
        template: "space lobster",
        title: "Agent",
      },
    });

    expect(card).toEqual(
      expect.objectContaining({
        header: {
          template: "blue",
          title: { content: "Agent", tag: "plain_text" },
        },
      }),
    );
  });
});

describe("buildMarkdownCard", () => {
  it("uses schema-2.0 width config instead of legacy wide screen mode", () => {
    const card = buildMarkdownCard("hello") as {
      config: {
        width_mode?: string;
        enable_forward?: boolean;
        wide_screen_mode?: boolean;
      };
    };

    expect(card.config.width_mode).toBe("fill");
    expect(card.config.enable_forward).toBeUndefined();
    expect(card.config.wide_screen_mode).toBeUndefined();
  });
});
