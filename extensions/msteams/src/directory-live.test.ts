import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  searchGraphUsersMock,
  listTeamsByNameMock,
  listChannelsForTeamMock,
  normalizeQueryMock,
  resolveGraphTokenMock,
} = vi.hoisted(() => ({
  listChannelsForTeamMock: vi.fn(),
  listTeamsByNameMock: vi.fn(),
  normalizeQueryMock: vi.fn((value?: string | null) => value?.trim() ?? ""),
  resolveGraphTokenMock: vi.fn(),
  searchGraphUsersMock: vi.fn(),
}));

vi.mock("./graph-users.js", () => ({ searchGraphUsers: searchGraphUsersMock }));

vi.mock("./graph.js", () => ({
  listChannelsForTeam: listChannelsForTeamMock,
  listTeamsByName: listTeamsByNameMock,
  normalizeQuery: normalizeQueryMock,
  resolveGraphToken: resolveGraphTokenMock,
}));

import { listMSTeamsDirectoryGroupsLive, listMSTeamsDirectoryPeersLive } from "./directory-live.js";

describe("msteams directory live", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    normalizeQueryMock.mockImplementation((value?: string | null) => value?.trim() ?? "");
  });

  it("returns normalized peer entries and skips users without ids", async () => {
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    searchGraphUsersMock.mockResolvedValue([
      {
        displayName: "Alice",
        id: "user-1",
        userPrincipalName: "alice@example.com",
      },
      {
        displayName: "Bob",
        id: "user-2",
        mail: "bob@example.com",
      },
      {
        displayName: "Missing Id",
      },
    ]);

    await expect(
      listMSTeamsDirectoryPeersLive({
        cfg: {},
        query: "  ali  ",
      }),
    ).resolves.toEqual([
      {
        handle: "@alice@example.com",
        id: "user:user-1",
        kind: "user",
        name: "Alice",
        raw: {
          displayName: "Alice",
          id: "user-1",
          userPrincipalName: "alice@example.com",
        },
      },
      {
        handle: "@bob@example.com",
        id: "user:user-2",
        kind: "user",
        name: "Bob",
        raw: {
          displayName: "Bob",
          id: "user-2",
          mail: "bob@example.com",
        },
      },
    ]);

    expect(searchGraphUsersMock).toHaveBeenCalledWith({
      query: "ali",
      token: "graph-token",
      top: 20,
    });
  });

  it("returns team entries without channel queries and honors limits", async () => {
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    listTeamsByNameMock.mockResolvedValue([
      { displayName: "Platform", id: "team-1" },
      { displayName: "Infra", id: "team-2" },
    ]);

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        limit: 1,
        query: "platform",
      }),
    ).resolves.toEqual([
      {
        handle: "#Platform",
        id: "team:team-1",
        kind: "group",
        name: "Platform",
        raw: { displayName: "Platform", id: "team-1" },
      },
    ]);
  });

  it("searches channels within matching teams when a team/channel query is used", async () => {
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    listTeamsByNameMock.mockResolvedValue([
      { displayName: "Platform", id: "team-1" },
      { displayName: "Infra", id: "team-2" },
    ]);
    listChannelsForTeamMock
      .mockResolvedValueOnce([
        { displayName: "Deployments", id: "chan-1" },
        { displayName: "General", id: "chan-2" },
      ])
      .mockResolvedValueOnce([{ displayName: "Deployments-West", id: "chan-3" }]);

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "plat / deploy",
      }),
    ).resolves.toEqual([
      {
        handle: "#Deployments",
        id: "conversation:chan-1",
        kind: "group",
        name: "Platform/Deployments",
        raw: { displayName: "Deployments", id: "chan-1" },
      },
      {
        handle: "#Deployments-West",
        id: "conversation:chan-3",
        kind: "group",
        name: "Infra/Deployments-West",
        raw: { displayName: "Deployments-West", id: "chan-3" },
      },
    ]);

    expect(listTeamsByNameMock).toHaveBeenCalledWith("graph-token", "plat");
  });
});
