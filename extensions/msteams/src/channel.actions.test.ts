import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsActionsAdapter } from "./actions.js";

const {
  editMessageMSTeamsMock,
  deleteMessageMSTeamsMock,
  getMessageMSTeamsMock,
  listReactionsMSTeamsMock,
  pinMessageMSTeamsMock,
  reactMessageMSTeamsMock,
  searchMessagesMSTeamsMock,
  sendAdaptiveCardMSTeamsMock,
  sendMessageMSTeamsMock,
  unpinMessageMSTeamsMock,
} = vi.hoisted(() => ({
  deleteMessageMSTeamsMock: vi.fn(),
  editMessageMSTeamsMock: vi.fn(),
  getMessageMSTeamsMock: vi.fn(),
  listReactionsMSTeamsMock: vi.fn(),
  pinMessageMSTeamsMock: vi.fn(),
  reactMessageMSTeamsMock: vi.fn(),
  searchMessagesMSTeamsMock: vi.fn(),
  sendAdaptiveCardMSTeamsMock: vi.fn(),
  sendMessageMSTeamsMock: vi.fn(),
  unpinMessageMSTeamsMock: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  msTeamsChannelRuntime: {
    deleteMessageMSTeams: deleteMessageMSTeamsMock,
    editMessageMSTeams: editMessageMSTeamsMock,
    getMessageMSTeams: getMessageMSTeamsMock,
    listReactionsMSTeams: listReactionsMSTeamsMock,
    pinMessageMSTeams: pinMessageMSTeamsMock,
    reactMessageMSTeams: reactMessageMSTeamsMock,
    searchMessagesMSTeams: searchMessagesMSTeamsMock,
    sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsMock,
    sendMessageMSTeams: sendMessageMSTeamsMock,
    unpinMessageMSTeams: unpinMessageMSTeamsMock,
  },
}));

const actionMocks = [
  editMessageMSTeamsMock,
  deleteMessageMSTeamsMock,
  getMessageMSTeamsMock,
  listReactionsMSTeamsMock,
  pinMessageMSTeamsMock,
  reactMessageMSTeamsMock,
  searchMessagesMSTeamsMock,
  sendAdaptiveCardMSTeamsMock,
  sendMessageMSTeamsMock,
  unpinMessageMSTeamsMock,
];
const currentChannelId = "conversation:19:ctx@thread.tacv2";
const reactChannelId = "conversation:19:react@thread.tacv2";
const targetChannelId = "conversation:19:target@thread.tacv2";
const editedConversationId = "19:edited@thread.tacv2";
const editedMessageId = "msg-edit-1";
const readMessage = { id: "msg-1", text: "hello" };
const reactionType = "like";
const updatedText = "updated text";
const reactionTypes = ["like", "heart", "laugh", "surprised", "sad", "angry"];
const deleteMissingTargetError = "Delete requires a target (to) and messageId.";
const reactionsMissingTargetError = "Reactions requires a target (to) and messageId.";
const cardSendMissingTargetError = "Card send requires a target (to).";
const reactMissingEmojiError =
  "React requires an emoji (reaction type). Valid types: like, heart, laugh, surprised, sad, angry.";
const reactMissingEmojiDetail = "React requires an emoji (reaction type).";
const searchMissingQueryError = "Search requires a target (to) and query.";

function padded(value: string) {
  return ` ${value} `;
}

function msteamsActionDetails(action: string, details?: Record<string, unknown>) {
  return {
    action,
    channel: "msteams",
    ...details,
  };
}

function okMSTeamsActionDetails(action: string, details?: Record<string, unknown>) {
  return msteamsActionDetails(action, { ok: true, ...details });
}

function requireMSTeamsHandleAction() {
  const {handleAction} = msteamsActionsAdapter;
  if (!handleAction) {
    throw new Error("msteams actions.handleAction unavailable");
  }
  return handleAction;
}

async function runAction(params: {
  action: string;
  cfg?: Record<string, unknown>;
  params?: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  mediaLocalRoots?: readonly string[];
}) {
  const handleAction = requireMSTeamsHandleAction();
  return await handleAction({
    action: params.action,
    cfg: params.cfg ?? {},
    channel: "msteams",
    mediaLocalRoots: params.mediaLocalRoots,
    params: params.params ?? {},
    toolContext: params.toolContext,
  } as Parameters<ReturnType<typeof requireMSTeamsHandleAction>>[0]);
}

async function expectActionError(
  params: Parameters<typeof runAction>[0],
  expectedMessage: string,
  expectedDetails?: Record<string, unknown>,
) {
  await expect(runAction(params)).resolves.toEqual({
    content: [{ text: expectedMessage, type: "text" }],
    details: expectedDetails ?? { error: expectedMessage },
    isError: true,
  });
}

async function expectActionParamError(
  action: Parameters<typeof runAction>[0]["action"],
  params: Record<string, unknown>,
  expectedMessage: string,
  expectedDetails?: Record<string, unknown>,
) {
  await expectActionError({ action, params }, expectedMessage, expectedDetails);
}

function expectActionSuccess(
  result: Awaited<ReturnType<typeof runAction>>,
  details: Record<string, unknown>,
  contentDetails: Record<string, unknown> = details,
) {
  expect(result).toEqual({
    content: [
      {
        text: JSON.stringify(contentDetails),
        type: "text",
      },
    ],
    details,
  });
}

function expectActionRuntimeCall(
  mockFn: ReturnType<typeof vi.fn>,
  params: Record<string, unknown>,
) {
  expect(mockFn).toHaveBeenCalledWith({
    cfg: {},
    ...params,
  });
}

async function expectSuccessfulAction(params: {
  mockFn: ReturnType<typeof vi.fn>;
  mockResult: unknown;
  action: Parameters<typeof runAction>[0]["action"];
  actionParams?: Parameters<typeof runAction>[0]["params"];
  toolContext?: Parameters<typeof runAction>[0]["toolContext"];
  mediaLocalRoots?: Parameters<typeof runAction>[0]["mediaLocalRoots"];
  runtimeParams: Record<string, unknown>;
  details: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
}) {
  params.mockFn.mockResolvedValue(params.mockResult);
  const result = await runAction({
    action: params.action,
    mediaLocalRoots: params.mediaLocalRoots,
    params: params.actionParams,
    toolContext: params.toolContext,
  });
  expectActionRuntimeCall(params.mockFn, params.runtimeParams);
  expectActionSuccess(result, params.details, params.contentDetails);
}

describe("msteamsPlugin message actions", () => {
  beforeEach(() => {
    for (const mockFn of actionMocks) {
      mockFn.mockReset();
    }
  });

  it("falls back to toolContext.currentChannelId for read actions", async () => {
    await expectSuccessfulAction({
      action: "read",
      actionParams: {
        messageId: padded("msg-1"),
      },
      contentDetails: {
        action: "read",
        channel: "msteams",
        message: readMessage,
        ok: true,
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      runtimeParams: {
        messageId: "msg-1",
        to: currentChannelId,
      },
      toolContext: {
        currentChannelId: padded(currentChannelId),
      },
    });
  });

  it("advertises upload-file in the message tool surface", () => {
    expect(
      msteamsActionsAdapter.describeMessageTool?.({
        cfg: {
          channels: {
            msteams: {
              appId: "app-id",
              appPassword: "secret",
              tenantId: "tenant-id",
            },
          },
        } as OpenClawConfig,
      })?.actions,
    ).toContain("upload-file");
  });

  it("routes upload-file through sendMessageMSTeams with filename override", async () => {
    await expectSuccessfulAction({
      action: "upload-file",
      actionParams: {
        filename: "Q1-report.pdf",
        message: "Quarterly report",
        path: " /tmp/report.pdf ",
        target: padded(targetChannelId),
      },
      contentDetails: {
        action: "upload-file",
        channel: "msteams",
        conversationId: "conv-upload-1",
        messageId: "msg-upload-1",
        ok: true,
      },
      details: {
        channel: "msteams",
        messageId: "msg-upload-1",
        ok: true,
      },
      mediaLocalRoots: ["/tmp"],
      mockFn: sendMessageMSTeamsMock,
      mockResult: {
        conversationId: "conv-upload-1",
        messageId: "msg-upload-1",
      },
      runtimeParams: {
        filename: "Q1-report.pdf",
        mediaLocalRoots: ["/tmp"],
        mediaUrl: " /tmp/report.pdf ",
        text: "Quarterly report",
        to: targetChannelId,
      },
    });
  });

  it("accepts target as an alias for pin actions", async () => {
    await expectSuccessfulAction({
      action: "pin",
      actionParams: {
        messageId: padded("msg-2"),
        target: padded(targetChannelId),
      },
      details: okMSTeamsActionDetails("pin", {
        pinnedMessageId: "pin-1",
      }),
      mockFn: pinMessageMSTeamsMock,
      mockResult: { ok: true, pinnedMessageId: "pin-1" },
      runtimeParams: {
        messageId: "msg-2",
        to: targetChannelId,
      },
    });
  });

  it("falls back from content to message fields for edit actions", async () => {
    await expectSuccessfulAction({
      action: "edit",
      actionParams: {
        content: updatedText,
        messageId: editedMessageId,
        to: targetChannelId,
      },
      contentDetails: {
        channel: "msteams",
        conversationId: editedConversationId,
        ok: true,
      },
      details: {
        channel: "msteams",
        ok: true,
      },
      mockFn: editMessageMSTeamsMock,
      mockResult: { conversationId: editedConversationId },
      runtimeParams: {
        activityId: editedMessageId,
        text: updatedText,
        to: targetChannelId,
      },
    });
  });

  it("falls back from pinnedMessageId to messageId for unpin actions", async () => {
    await expectSuccessfulAction({
      action: "unpin",
      actionParams: {
        messageId: padded("pin-2"),
        target: padded(targetChannelId),
      },
      details: okMSTeamsActionDetails("unpin"),
      mockFn: unpinMessageMSTeamsMock,
      mockResult: { ok: true },
      runtimeParams: {
        pinnedMessageId: "pin-2",
        to: targetChannelId,
      },
    });
  });

  it("reuses currentChannelId fallback for react actions", async () => {
    await expectSuccessfulAction({
      action: "react",
      actionParams: {
        emoji: padded(reactionType),
        messageId: padded("msg-3"),
      },
      contentDetails: {
        action: "react",
        channel: "msteams",
        ok: true,
        reactionType,
      },
      details: okMSTeamsActionDetails("react", {
        reactionType,
      }),
      mockFn: reactMessageMSTeamsMock,
      mockResult: { ok: true },
      runtimeParams: {
        messageId: "msg-3",
        reactionType,
        to: reactChannelId,
      },
      toolContext: {
        currentChannelId: padded(reactChannelId),
      },
    });
  });

  it("shares the missing target and messageId validation across actions", async () => {
    await expectActionParamError("delete", {}, deleteMissingTargetError);

    await expectActionParamError("reactions", { to: targetChannelId }, reactionsMissingTargetError);
  });

  it("keeps card-send target validation shared", async () => {
    await expectActionParamError(
      "send",
      { card: { type: "AdaptiveCard" } },
      cardSendMissingTargetError,
    );
  });

  it("reports the allowed reaction types when emoji is missing", async () => {
    await expectActionParamError(
      "react",
      {
        messageId: "msg-4",
        to: targetChannelId,
      },
      reactMissingEmojiError,
      {
        error: reactMissingEmojiDetail,
        validTypes: reactionTypes,
      },
    );
  });

  it("requires a non-empty search query after trimming", async () => {
    await expectActionParamError(
      "search",
      {
        query: "   ",
        to: targetChannelId,
      },
      searchMissingQueryError,
    );
  });
});
