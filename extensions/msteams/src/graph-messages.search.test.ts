import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  CHANNEL_TO,
  CHAT_ID,
  type GraphMessagesTestModule,
  getGraphMessagesMockState,
  installGraphMessagesMockDefaults,
  loadGraphMessagesTestModule,
} from "./graph-messages.test-helpers.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let searchMessagesMSTeams: GraphMessagesTestModule["searchMessagesMSTeams"];

beforeAll(async () => {
  ({ searchMessagesMSTeams } = await loadGraphMessagesTestModule());
});

describe("searchMessagesMSTeams", () => {
  it("searches chat messages with query string", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          body: { content: "Meeting notes from Monday" },
          createdDateTime: "2026-03-25T10:00:00Z",
          from: { user: { displayName: "Alice", id: "u1" } },
          id: "msg-1",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      query: "meeting notes",
      to: CHAT_ID,
    });

    expect(result.messages).toEqual([
      {
        createdAt: "2026-03-25T10:00:00Z",
        from: { user: { displayName: "Alice", id: "u1" } },
        id: "msg-1",
        text: "Meeting notes from Monday",
      },
    ]);
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain(`/chats/${encodeURIComponent(CHAT_ID)}/messages?`);
    expect(calledPath).toContain("$search=");
    expect(calledPath).toContain("$top=25");
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain('$search="meeting notes"');
  });

  it("searches channel messages", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          body: { content: "Sprint review" },
          createdDateTime: "2026-03-25T11:00:00Z",
          from: { user: { displayName: "Bob", id: "u2" } },
          id: "msg-2",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      query: "sprint",
      to: CHANNEL_TO,
    });

    expect(result.messages).toHaveLength(1);
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("/teams/team-id-1/channels/channel-id-1/messages?");
  });

  it("applies limit parameter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      limit: 10,
      query: "test",
      to: CHAT_ID,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$top=10");
  });

  it("clamps limit to max 50", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      limit: 100,
      query: "test",
      to: CHAT_ID,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$top=50");
  });

  it("clamps limit to min 1", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      limit: 0,
      query: "test",
      to: CHAT_ID,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$top=1");
  });

  it("applies from filter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      from: "Alice",
      query: "budget",
      to: CHAT_ID,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$filter=");
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain("from/user/displayName eq 'Alice'");
  });

  it("escapes single quotes in from filter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      from: "O'Brien",
      query: "test",
      to: CHAT_ID,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain("O''Brien");
  });

  it("strips double quotes from query to prevent injection", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      query: 'say "hello" world',
      to: CHAT_ID,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain('$search="say hello world"');
    expect(decoded).not.toContain('""');
  });

  it("passes ConsistencyLevel: eventual header", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      query: "test",
      to: CHAT_ID,
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { ConsistencyLevel: "eventual" },
      }),
    );
  });

  it("returns empty array when no messages match", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      query: "nonexistent",
      to: CHAT_ID,
    });

    expect(result.messages).toEqual([]);
  });

  it("resolves user: target through conversation store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-id",
      reference: { graphChatId: "19:dm-chat@thread.tacv2" },
    });
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      query: "hello",
      to: "user:aad-user-1",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain(
      `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages?`,
    );
  });
});
