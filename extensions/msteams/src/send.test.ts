import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { deleteMessageMSTeams, editMessageMSTeams, sendMessageMSTeams } from "./send.js";

const mockState = vi.hoisted(() => ({
  buildTeamsFileInfoCard: vi.fn(),
  convertMarkdownTables: vi.fn((text: string) => text),
  extractFilename: vi.fn(async () => "fallback.bin"),
  getDriveItemProperties: vi.fn(),
  loadOutboundMediaFromUrl: vi.fn(),
  prepareFileConsentActivity: vi.fn(),
  requiresFileConsent: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "off"),
  runtimeConvertMarkdownTables: vi.fn((text: string) => text),
  runtimeResolveMarkdownTableMode: vi.fn(() => "off"),
  sendMSTeamsMessages: vi.fn(),
  uploadAndShareSharePoint: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/msteams", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  resolveMarkdownTableMode: mockState.resolveMarkdownTableMode,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-runtime")>();
  return {
    ...actual,
    convertMarkdownTables: mockState.convertMarkdownTables,
  };
});

vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: mockState.resolveMSTeamsSendContext,
}));

vi.mock("./file-consent-helpers.js", () => ({
  prepareFileConsentActivity: mockState.prepareFileConsentActivity,
  requiresFileConsent: mockState.requiresFileConsent,
}));

vi.mock("./media-helpers.js", () => ({
  extractFilename: mockState.extractFilename,
  extractMessageId: () => "message-1",
}));

vi.mock("./messenger.js", () => ({
  buildConversationReference: () => ({}),
  sendMSTeamsMessages: mockState.sendMSTeamsMessages,
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    channel: {
      text: {
        convertMarkdownTables: mockState.runtimeConvertMarkdownTables,
        resolveMarkdownTableMode: mockState.runtimeResolveMarkdownTableMode,
      },
    },
  }),
}));

vi.mock("./graph-upload.js", () => ({
  getDriveItemProperties: mockState.getDriveItemProperties,
  uploadAndShareOneDrive: vi.fn(),
  uploadAndShareSharePoint: mockState.uploadAndShareSharePoint,
}));

vi.mock("./graph-chat.js", () => ({
  buildTeamsFileInfoCard: mockState.buildTeamsFileInfoCard,
}));

function mockContinueConversationFailure(error: string) {
  const mockContinueConversation = vi.fn().mockRejectedValue(new Error(error));
  mockState.resolveMSTeamsSendContext.mockResolvedValue({
    adapter: { continueConversation: mockContinueConversation },
    appId: "app-id",
    conversationId: "19:conversation@thread.tacv2",
    conversationType: "personal",
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    ref: {
      agent: { id: "agent-1" },
      channelId: "msteams",
      conversation: { id: "19:conversation@thread.tacv2" },
      user: { id: "user-1" },
    },
    tokenProvider: {},
  });
  return mockContinueConversation;
}

function createSharePointSendContext(params: {
  conversationId: string;
  graphChatId: string | null;
  siteId: string;
}) {
  return {
    adapter: {
      continueConversation: vi.fn(
        async (
          _id: string,
          _ref: unknown,
          fn: (ctx: { sendActivity: () => { id: "msg-1" } }) => Promise<void>,
        ) => fn({ sendActivity: () => ({ id: "msg-1" }) }),
      ),
    },
    appId: "app-id",
    conversationId: params.conversationId,
    conversationType: "groupChat" as const,
    graphChatId: params.graphChatId,
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    mediaMaxBytes: 8 * 1024 * 1024,
    ref: {},
    sharePointSiteId: params.siteId,
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
  };
}

function mockSharePointPdfUpload(params: {
  bufferSize: number;
  fileName: string;
  itemId: string;
  uniqueId: string;
}) {
  mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
    buffer: Buffer.alloc(params.bufferSize, "pdf"),
    contentType: "application/pdf",
    fileName: params.fileName,
    kind: "file",
  });
  mockState.requiresFileConsent.mockReturnValue(false);
  mockState.uploadAndShareSharePoint.mockResolvedValue({
    itemId: params.itemId,
    name: params.fileName,
    shareUrl: `https://sp.example.com/share/${params.fileName}`,
    webUrl: `https://sp.example.com/${params.fileName}`,
  });
  mockState.getDriveItemProperties.mockResolvedValue({
    eTag: `"${params.uniqueId},1"`,
    name: params.fileName,
    webDavUrl: `https://sp.example.com/dav/${params.fileName}`,
  });
  mockState.buildTeamsFileInfoCard.mockReturnValue({
    content: { fileType: "pdf", uniqueId: params.uniqueId },
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: `https://sp.example.com/dav/${params.fileName}`,
    name: params.fileName,
  });
}

describe("sendMessageMSTeams", () => {
  beforeEach(() => {
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.resolveMarkdownTableMode.mockReset();
    mockState.resolveMarkdownTableMode.mockReturnValue("off");
    mockState.convertMarkdownTables.mockReset();
    mockState.convertMarkdownTables.mockImplementation((text: string) => text);
    mockState.runtimeResolveMarkdownTableMode.mockReset();
    mockState.runtimeResolveMarkdownTableMode.mockReturnValue("off");
    mockState.runtimeConvertMarkdownTables.mockReset();
    mockState.runtimeConvertMarkdownTables.mockImplementation((text: string) => text);
    mockState.requiresFileConsent.mockReset();
    mockState.prepareFileConsentActivity.mockReset();
    mockState.extractFilename.mockReset();
    mockState.sendMSTeamsMessages.mockReset();
    mockState.uploadAndShareSharePoint.mockReset();
    mockState.getDriveItemProperties.mockReset();
    mockState.buildTeamsFileInfoCard.mockReset();

    mockState.extractFilename.mockResolvedValue("fallback.bin");
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: {},
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      conversationType: "personal",
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      mediaMaxBytes: 8 * 1024,
      ref: {},
      sharePointSiteId: undefined,
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    });
    mockState.sendMSTeamsMessages.mockResolvedValue(["message-1"]);
  });

  it("loads media through shared helper and forwards mediaLocalRoots", async () => {
    const mediaBuffer = Buffer.from("tiny-image");
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: mediaBuffer,
      contentType: "image/png",
      fileName: "inline.png",
      kind: "image",
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      mediaLocalRoots: ["/tmp/agent-workspace"],
      mediaUrl: "file:///tmp/agent-workspace/inline.png",
      text: "hello",
      to: "conversation:19:conversation@thread.tacv2",
    });

    expect(mockState.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "file:///tmp/agent-workspace/inline.png",
      {
        maxBytes: 8 * 1024,
        mediaLocalRoots: ["/tmp/agent-workspace"],
      },
    );

    expect(mockState.sendMSTeamsMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            mediaUrl: `data:image/png;base64,${mediaBuffer.toString("base64")}`,
            text: "hello",
          }),
        ],
      }),
    );
  });

  it("sends with provided cfg even when Teams runtime text helpers are unavailable", async () => {
    mockState.runtimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("MSTeams runtime not initialized");
    });
    mockState.runtimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("MSTeams runtime not initialized");
    });
    mockState.resolveMarkdownTableMode.mockReturnValue("off");
    mockState.convertMarkdownTables.mockReturnValue("hello");

    await expect(
      sendMessageMSTeams({
        cfg: {} as OpenClawConfig,
        text: "hello",
        to: "conversation:19:conversation@thread.tacv2",
      }),
    ).resolves.toEqual({
      conversationId: "19:conversation@thread.tacv2",
      messageId: "message-1",
    });

    expect(mockState.resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg: {},
      channel: "msteams",
    });
    expect(mockState.convertMarkdownTables).toHaveBeenCalledWith("hello", "off");
  });

  it("uses graphChatId instead of conversationId when uploading to SharePoint", async () => {
    // Simulates a group chat where Bot Framework conversationId is valid but we have
    // A resolved Graph chat ID cached from a prior send.
    const graphChatId = "19:graph-native-chat-id@thread.tacv2";
    const botFrameworkConversationId = "19:bot-framework-id@thread.tacv2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue(
      createSharePointSendContext({
        conversationId: botFrameworkConversationId,
        graphChatId,
        siteId: "site-123",
      }),
    );
    mockSharePointPdfUpload({
      bufferSize: 100,
      fileName: "doc.pdf",
      itemId: "item-1",
      uniqueId: "{GUID-123}",
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      mediaUrl: "https://example.com/doc.pdf",
      text: "here is a file",
      to: "conversation:19:bot-framework-id@thread.tacv2",
    });

    // The Graph-native chatId must be passed to SharePoint upload, not the Bot Framework ID
    expect(mockState.uploadAndShareSharePoint).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: graphChatId,
        siteId: "site-123",
      }),
    );
  });

  it("falls back to conversationId when graphChatId is not available", async () => {
    const botFrameworkConversationId = "19:fallback-id@thread.tacv2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue(
      createSharePointSendContext({
        conversationId: botFrameworkConversationId,
        graphChatId: null,
        siteId: "site-456",
      }),
    );
    mockSharePointPdfUpload({
      bufferSize: 50,
      fileName: "report.pdf",
      itemId: "item-2",
      uniqueId: "{GUID-456}",
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      mediaUrl: "https://example.com/report.pdf",
      text: "report",
      to: "conversation:19:fallback-id@thread.tacv2",
    });

    // Falls back to conversationId when graphChatId is null
    expect(mockState.uploadAndShareSharePoint).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: botFrameworkConversationId,
        siteId: "site-456",
      }),
    );
  });
});

describe("editMessageMSTeams", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
  });

  it("calls continueConversation and updateActivity with correct params", async () => {
    const mockUpdateActivity = vi.fn();
    const mockContinueConversation = vi.fn(
      async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({
          deleteActivity: vi.fn(),
          sendActivity: vi.fn(),
          updateActivity: mockUpdateActivity,
        });
      },
    );
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: { continueConversation: mockContinueConversation },
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      conversationType: "personal",
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      ref: {
        agent: { id: "agent-1" },
        channelId: "msteams",
        conversation: { conversationType: "personal", id: "19:conversation@thread.tacv2" },
        user: { id: "user-1" },
      },
      tokenProvider: {},
    });

    const result = await editMessageMSTeams({
      activityId: "activity-123",
      cfg: {} as OpenClawConfig,
      text: "Updated message text",
      to: "conversation:19:conversation@thread.tacv2",
    });

    expect(result.conversationId).toBe("19:conversation@thread.tacv2");
    expect(mockContinueConversation).toHaveBeenCalledTimes(1);
    expect(mockContinueConversation).toHaveBeenCalledWith(
      "app-id",
      expect.objectContaining({ activityId: undefined }),
      expect.any(Function),
    );
    expect(mockUpdateActivity).toHaveBeenCalledWith({
      id: "activity-123",
      text: "Updated message text",
      type: "message",
    });
  });

  it("throws a descriptive error when continueConversation fails", async () => {
    mockContinueConversationFailure("Service unavailable");

    await expect(
      editMessageMSTeams({
        activityId: "activity-123",
        cfg: {} as OpenClawConfig,
        text: "Updated text",
        to: "conversation:19:conversation@thread.tacv2",
      }),
    ).rejects.toThrow("msteams edit failed");
  });
});

describe("deleteMessageMSTeams", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsSendContext.mockReset();
  });

  it("calls continueConversation and deleteActivity with correct activityId", async () => {
    const mockDeleteActivity = vi.fn();
    const mockContinueConversation = vi.fn(
      async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({
          deleteActivity: mockDeleteActivity,
          sendActivity: vi.fn(),
          updateActivity: vi.fn(),
        });
      },
    );
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: { continueConversation: mockContinueConversation },
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      conversationType: "groupChat",
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      ref: {
        agent: { id: "agent-1" },
        channelId: "msteams",
        conversation: { conversationType: "groupChat", id: "19:conversation@thread.tacv2" },
        user: { id: "user-1" },
      },
      tokenProvider: {},
    });

    const result = await deleteMessageMSTeams({
      activityId: "activity-456",
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
    });

    expect(result.conversationId).toBe("19:conversation@thread.tacv2");
    expect(mockContinueConversation).toHaveBeenCalledTimes(1);
    expect(mockContinueConversation).toHaveBeenCalledWith(
      "app-id",
      expect.objectContaining({ activityId: undefined }),
      expect.any(Function),
    );
    expect(mockDeleteActivity).toHaveBeenCalledWith("activity-456");
  });

  it("throws a descriptive error when continueConversation fails", async () => {
    mockContinueConversationFailure("Not found");

    await expect(
      deleteMessageMSTeams({
        activityId: "activity-456",
        cfg: {} as OpenClawConfig,
        to: "conversation:19:conversation@thread.tacv2",
      }),
    ).rejects.toThrow("msteams delete failed");
  });

  it("passes the appId and proactive ref to continueConversation", async () => {
    const mockContinueConversation = vi.fn(
      async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({
          deleteActivity: vi.fn(),
          sendActivity: vi.fn(),
          updateActivity: vi.fn(),
        });
      },
    );
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: { continueConversation: mockContinueConversation },
      appId: "my-app-id",
      conversationId: "19:conv@thread.tacv2",
      conversationType: "personal",
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      ref: {
        activityId: "original-activity",
        agent: { id: "agent-1" },
        channelId: "msteams",
        conversation: { id: "19:conv@thread.tacv2" },
        user: { id: "user-1" },
      },
      tokenProvider: {},
    });

    await deleteMessageMSTeams({
      activityId: "activity-789",
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conv@thread.tacv2",
    });

    // AppId should be forwarded correctly
    expect(mockContinueConversation.mock.calls[0]?.[0]).toBe("my-app-id");
    // ActivityId on the proactive ref should be cleared (undefined) — proactive pattern
    expect(mockContinueConversation.mock.calls[0]?.[1]).toMatchObject({
      activityId: undefined,
    });
  });
});
