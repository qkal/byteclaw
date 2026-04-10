import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledGoogleChatAccounts = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const createGoogleChatReaction = vi.hoisted(() => vi.fn());
const deleteGoogleChatReaction = vi.hoisted(() => vi.fn());
const listGoogleChatReactions = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const uploadGoogleChatAttachment = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());
const getGoogleChatRuntime = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  listEnabledGoogleChatAccounts,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  createGoogleChatReaction,
  deleteGoogleChatReaction,
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment,
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    loadOutboundMediaFromUrl: (...args: Parameters<typeof actual.loadOutboundMediaFromUrl>) =>
      (loadOutboundMediaFromUrl as unknown as typeof actual.loadOutboundMediaFromUrl)(...args),
  };
});

let googlechatMessageActions: typeof import("./actions.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./actions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("describes send and reaction actions only when enabled accounts exist", async () => {
    listEnabledGoogleChatAccounts.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listEnabledGoogleChatAccounts.mockReturnValueOnce([
      {
        config: { actions: { reactions: true } },
        credentialSource: "service-account",
        enabled: true,
      },
    ]);

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send", "upload-file", "react", "reactions"],
    });
  });

  it("honors account-scoped reaction gates during discovery", () => {
    resolveGoogleChatAccount.mockImplementation(({ accountId }: { accountId?: string | null }) => ({
      config: {
        actions: { reactions: accountId === "work" },
      },
      credentialSource: "service-account",
      enabled: true,
    }));

    expect(
      googlechatMessageActions.describeMessageTool?.({ accountId: "default", cfg: {} as never }),
    ).toEqual({
      actions: ["send", "upload-file"],
    });
    expect(
      googlechatMessageActions.describeMessageTool?.({ accountId: "work", cfg: {} as never }),
    ).toEqual({
      actions: ["send", "upload-file", "react", "reactions"],
    });
  });

  it("sends messages with uploaded media through the resolved space", async () => {
    resolveGoogleChatAccount.mockReturnValue({
      config: { mediaMaxMb: 5 },
      credentialSource: "service-account",
    });
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    getGoogleChatRuntime.mockReturnValue({
      channel: {
        media: {
          fetchRemoteMedia: vi.fn(async () => ({
            buffer: Buffer.from("remote-bytes"),
            contentType: "image/png",
            fileName: "remote.png",
          })),
        },
      },
    });
    uploadGoogleChatAttachment.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      accountId: "default",
      action: "send",
      cfg: {},
      params: {
        media: "https://example.com/file.png",
        message: "caption",
        threadId: "thread-1",
        to: "spaces/AAA",
      },
    } as never);

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "spaces/AAA",
      }),
    );
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "remote.png",
        space: "spaces/AAA",
      }),
    );
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
        thread: "thread-1",
      }),
    );
    expect(result).toMatchObject({
      details: {
        ok: true,
        to: "spaces/AAA",
      },
    });
  });

  it("routes upload-file through the same attachment upload path with filename override", async () => {
    resolveGoogleChatAccount.mockReturnValue({
      config: { mediaMaxMb: 5 },
      credentialSource: "service-account",
    });
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/BBB");
    loadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("local-bytes"),
      contentType: "text/plain",
      fileName: "local.txt",
    });
    getGoogleChatRuntime.mockReturnValue({
      channel: {
        media: {
          fetchRemoteMedia: vi.fn(),
        },
      },
    });
    uploadGoogleChatAttachment.mockResolvedValue({
      attachmentUploadToken: "token-2",
    });
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/BBB/messages/msg-2",
    });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      accountId: "default",
      action: "upload-file",
      cfg: {},
      mediaLocalRoots: ["/tmp"],
      params: {
        filename: "renamed.txt",
        message: "notes",
        path: "/tmp/local.txt",
        to: "spaces/BBB",
      },
    } as never);

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/local.txt",
      expect.objectContaining({ mediaLocalRoots: ["/tmp"] }),
    );
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "renamed.txt",
        space: "spaces/BBB",
      }),
    );
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ attachmentUploadToken: "token-2", contentName: "renamed.txt" }],
        space: "spaces/BBB",
        text: "notes",
      }),
    );
    expect(result).toMatchObject({
      details: {
        ok: true,
        to: "spaces/BBB",
      },
    });
  });

  it("removes only matching app reactions on react remove", async () => {
    resolveGoogleChatAccount.mockReturnValue({
      config: { botUser: "users/app-bot" },
      credentialSource: "service-account",
    });
    listGoogleChatReactions.mockResolvedValue([
      {
        emoji: { unicode: "👍" },
        name: "reactions/1",
        user: { name: "users/app" },
      },
      {
        emoji: { unicode: "👍" },
        name: "reactions/2",
        user: { name: "users/app-bot" },
      },
      {
        emoji: { unicode: "👍" },
        name: "reactions/3",
        user: { name: "users/other" },
      },
    ]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      accountId: "default",
      action: "react",
      cfg: {},
      params: {
        emoji: "👍",
        messageId: "spaces/AAA/messages/msg-1",
        remove: true,
      },
    } as never);

    expect(deleteGoogleChatReaction).toHaveBeenCalledTimes(2);
    expect(deleteGoogleChatReaction).toHaveBeenNthCalledWith(1, {
      account: expect.anything(),
      reactionName: "reactions/1",
    });
    expect(deleteGoogleChatReaction).toHaveBeenNthCalledWith(2, {
      account: expect.anything(),
      reactionName: "reactions/2",
    });
    expect(result).toMatchObject({
      details: {
        ok: true,
        removed: 2,
      },
    });
  });
});
