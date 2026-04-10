import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendImageZalouser, sendLinkZalouser, sendMessageZalouser } from "./send.js";
import { createZalouserTool, executeZalouserTool } from "./tool.js";
import {
  checkZaloAuthenticated,
  getZaloUserInfo,
  listZaloFriendsMatching,
  listZaloGroupsMatching,
} from "./zalo-js.js";

vi.mock("./send.js", () => ({
  sendImageZalouser: vi.fn(),
  sendLinkZalouser: vi.fn(),
  sendMessageZalouser: vi.fn(),
  sendReactionZalouser: vi.fn(),
}));

vi.mock("./zalo-js.js", () => ({
  checkZaloAuthenticated: vi.fn(),
  getZaloUserInfo: vi.fn(),
  listZaloFriendsMatching: vi.fn(),
  listZaloGroupsMatching: vi.fn(),
}));

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendImage = vi.mocked(sendImageZalouser);
const mockSendLink = vi.mocked(sendLinkZalouser);
const mockCheckAuth = vi.mocked(checkZaloAuthenticated);
const mockGetUserInfo = vi.mocked(getZaloUserInfo);
const mockListFriends = vi.mocked(listZaloFriendsMatching);
const mockListGroups = vi.mocked(listZaloGroupsMatching);

function extractDetails(result: { content?: { type: string; text?: string }[] }): unknown {
  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as unknown;
}

describe("executeZalouserTool", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockSendImage.mockReset();
    mockSendLink.mockReset();
    mockCheckAuth.mockReset();
    mockGetUserInfo.mockReset();
    mockListFriends.mockReset();
    mockListGroups.mockReset();
  });

  it("returns error when send action is missing required fields", async () => {
    const result = await executeZalouserTool("tool-1", { action: "send" });
    expect(extractDetails(result)).toEqual({
      error: "threadId and message required for send action",
    });
  });

  it("sends text message for send action", async () => {
    mockSendMessage.mockResolvedValueOnce({ messageId: "m-1", ok: true });
    const result = await executeZalouserTool("tool-1", {
      action: "send",
      isGroup: true,
      message: "hello",
      profile: "work",
      threadId: "t-1",
    });
    expect(mockSendMessage).toHaveBeenCalledWith("t-1", "hello", {
      isGroup: true,
      profile: "work",
    });
    expect(extractDetails(result)).toEqual({ messageId: "m-1", success: true });
  });

  it("defaults send routing from ambient deliveryContext target", async () => {
    mockSendMessage.mockResolvedValueOnce({ messageId: "m-ambient", ok: true });
    const tool = createZalouserTool({
      deliveryContext: {
        channel: "zalouser",
        to: "zalouser:g-ambient",
      },
    });

    const result = await tool.execute("tool-1", {
      action: "send",
      message: "hello",
    });

    expect(mockSendMessage).toHaveBeenCalledWith("g-ambient", "hello", {
      isGroup: true,
      profile: undefined,
    });
    expect(extractDetails(result)).toEqual({ messageId: "m-ambient", success: true });
  });

  it("keeps explicit threadId over ambient delivery defaults", async () => {
    mockSendMessage.mockResolvedValueOnce({ messageId: "m-explicit", ok: true });
    const tool = createZalouserTool({
      deliveryContext: {
        channel: "zalouser",
        to: "zalouser:g-ambient",
      },
    });

    await tool.execute("tool-1", {
      action: "send",
      isGroup: false,
      message: "hello",
      threadId: "u-explicit",
    });

    expect(mockSendMessage).toHaveBeenCalledWith("u-explicit", "hello", {
      isGroup: false,
      profile: undefined,
    });
  });

  it("does not route send actions from foreign ambient thread defaults", async () => {
    const tool = createZalouserTool({
      deliveryContext: {
        channel: "slack",
        threadId: "1710000000.000100",
        to: "channel:C123",
      },
    });

    const result = await tool.execute("tool-1", {
      action: "send",
      message: "hello",
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(extractDetails(result)).toEqual({
      error: "threadId and message required for send action",
    });
  });

  it("returns tool error when send action fails", async () => {
    mockSendMessage.mockResolvedValueOnce({ error: "blocked", ok: false });
    const result = await executeZalouserTool("tool-1", {
      action: "send",
      message: "hello",
      threadId: "t-1",
    });
    expect(extractDetails(result)).toEqual({ error: "blocked" });
  });

  it("routes image and link actions to correct helpers", async () => {
    mockSendImage.mockResolvedValueOnce({ messageId: "img-1", ok: true });
    const imageResult = await executeZalouserTool("tool-1", {
      action: "image",
      isGroup: true,
      message: "caption",
      threadId: "g-1",
      url: "https://example.com/image.jpg",
    });
    expect(mockSendImage).toHaveBeenCalledWith("g-1", "https://example.com/image.jpg", {
      caption: "caption",
      isGroup: true,
      profile: undefined,
    });
    expect(extractDetails(imageResult)).toEqual({ messageId: "img-1", success: true });

    mockSendLink.mockResolvedValueOnce({ messageId: "lnk-1", ok: true });
    const linkResult = await executeZalouserTool("tool-1", {
      action: "link",
      message: "read this",
      threadId: "t-2",
      url: "https://openclaw.ai",
    });
    expect(mockSendLink).toHaveBeenCalledWith("t-2", "https://openclaw.ai", {
      caption: "read this",
      isGroup: undefined,
      profile: undefined,
    });
    expect(extractDetails(linkResult)).toEqual({ messageId: "lnk-1", success: true });
  });

  it("returns friends/groups lists", async () => {
    mockListFriends.mockResolvedValueOnce([{ displayName: "Alice", userId: "1" }]);
    mockListGroups.mockResolvedValueOnce([{ groupId: "2", name: "Work" }]);

    const friends = await executeZalouserTool("tool-1", {
      action: "friends",
      profile: "work",
      query: "ali",
    });
    expect(mockListFriends).toHaveBeenCalledWith("work", "ali");
    expect(extractDetails(friends)).toEqual([{ displayName: "Alice", userId: "1" }]);

    const groups = await executeZalouserTool("tool-1", {
      action: "groups",
      profile: "work",
      query: "wrk",
    });
    expect(mockListGroups).toHaveBeenCalledWith("work", "wrk");
    expect(extractDetails(groups)).toEqual([{ groupId: "2", name: "Work" }]);
  });

  it("reports me + status actions", async () => {
    mockGetUserInfo.mockResolvedValueOnce({ displayName: "Me", userId: "7" });
    mockCheckAuth.mockResolvedValueOnce(true);

    const me = await executeZalouserTool("tool-1", { action: "me", profile: "work" });
    expect(mockGetUserInfo).toHaveBeenCalledWith("work");
    expect(extractDetails(me)).toEqual({ displayName: "Me", userId: "7" });

    const status = await executeZalouserTool("tool-1", { action: "status", profile: "work" });
    expect(mockCheckAuth).toHaveBeenCalledWith("work");
    expect(extractDetails(status)).toEqual({
      authenticated: true,
      output: "authenticated",
    });
  });
});
