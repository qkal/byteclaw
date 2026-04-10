import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { getChannelInfoMSTeams, listChannelsMSTeams } from "./graph-teams.js";

const mockState = vi.hoisted(() => ({
  fetchGraphJson: vi.fn(),
  resolveGraphToken: vi.fn(),
}));

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return {
    ...actual,
    fetchGraphJson: mockState.fetchGraphJson,
    resolveGraphToken: mockState.resolveGraphToken,
  };
});

const TOKEN = "test-graph-token";

describe("listChannelsMSTeams", () => {
  beforeEach(() => {
    mockState.resolveGraphToken.mockReset().mockResolvedValue(TOKEN);
    mockState.fetchGraphJson.mockReset();
  });

  it("returns channels with all fields mapped", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          description: "The default channel",
          displayName: "General",
          id: "ch-1",
          membershipType: "standard",
        },
        {
          description: "Engineering discussions",
          displayName: "Engineering",
          id: "ch-2",
          membershipType: "private",
        },
      ],
    });

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-abc",
    });

    expect(result.channels).toEqual([
      {
        description: "The default channel",
        displayName: "General",
        id: "ch-1",
        membershipType: "standard",
      },
      {
        description: "Engineering discussions",
        displayName: "Engineering",
        id: "ch-2",
        membershipType: "private",
      },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/teams/${encodeURIComponent("team-abc")}/channels?$select=id,displayName,description,membershipType`,
      token: TOKEN,
    });
  });

  it("returns empty array when team has no channels", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-empty",
    });

    expect(result.channels).toEqual([]);
  });

  it("returns empty array when value is undefined", async () => {
    mockState.fetchGraphJson.mockResolvedValue({});

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-no-value",
    });

    expect(result.channels).toEqual([]);
  });

  it("follows @odata.nextLink across multiple pages", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/teams/team-paged/channels?$select=id,displayName,description,membershipType&$skip=1",
        value: [
          { description: null, displayName: "General", id: "ch-1", membershipType: "standard" },
        ],
      })
      .mockResolvedValueOnce({
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/teams/team-paged/channels?$select=id,displayName,description,membershipType&$skip=2",
        value: [
          { description: "Fun", displayName: "Random", id: "ch-2", membershipType: "standard" },
        ],
      })
      .mockResolvedValueOnce({
        value: [
          { description: null, displayName: "Private", id: "ch-3", membershipType: "private" },
        ],
      });

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-paged",
    });

    expect(result.channels).toHaveLength(3);
    expect(result.channels.map((ch) => ch.id)).toEqual(["ch-1", "ch-2", "ch-3"]);
    expect(result.truncated).toBe(false);
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(3);

    // Second call should use the relative path stripped from the nextLink
    const secondCallPath = mockState.fetchGraphJson.mock.calls[1]?.[0]?.path;
    expect(secondCallPath).toBe(
      "/teams/team-paged/channels?$select=id,displayName,description,membershipType&$skip=1",
    );
  });

  it("stops after 10 pages to avoid runaway pagination", async () => {
    for (let i = 0; i < 11; i++) {
      mockState.fetchGraphJson.mockResolvedValueOnce({
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/teams/team-huge/channels?$skip=${i + 1}`,
        value: [
          {
            description: null,
            displayName: `Channel ${i}`,
            id: `ch-${i}`,
            membershipType: "standard",
          },
        ],
      });
    }

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-huge",
    });

    // Should stop at 10 pages even though more nextLinks are available
    expect(result.channels).toHaveLength(10);
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(10);
    expect(result.truncated).toBe(true);
  });
});

describe("getChannelInfoMSTeams", () => {
  beforeEach(() => {
    mockState.resolveGraphToken.mockReset().mockResolvedValue(TOKEN);
    mockState.fetchGraphJson.mockReset();
  });

  it("returns channel with all fields", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      createdDateTime: "2026-01-15T09:00:00Z",
      description: "The default channel",
      displayName: "General",
      id: "ch-1",
      membershipType: "standard",
      webUrl: "https://teams.microsoft.com/l/channel/ch-1/General",
    });

    const result = await getChannelInfoMSTeams({
      cfg: {} as OpenClawConfig,
      channelId: "ch-1",
      teamId: "team-abc",
    });

    expect(result.channel).toEqual({
      createdDateTime: "2026-01-15T09:00:00Z",
      description: "The default channel",
      displayName: "General",
      id: "ch-1",
      membershipType: "standard",
      webUrl: "https://teams.microsoft.com/l/channel/ch-1/General",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/teams/${encodeURIComponent("team-abc")}/channels/${encodeURIComponent("ch-1")}?$select=id,displayName,description,membershipType,webUrl,createdDateTime`,
      token: TOKEN,
    });
  });

  it("handles missing optional fields gracefully", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      displayName: "Private Channel",
      id: "ch-2",
    });

    const result = await getChannelInfoMSTeams({
      cfg: {} as OpenClawConfig,
      channelId: "ch-2",
      teamId: "team-abc",
    });

    expect(result.channel).toEqual({
      createdDateTime: undefined,
      description: undefined,
      displayName: "Private Channel",
      id: "ch-2",
      membershipType: undefined,
      webUrl: undefined,
    });
  });
});
