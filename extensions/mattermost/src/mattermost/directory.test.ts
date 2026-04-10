import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listMattermostAccountIdsMock,
  resolveMattermostAccountMock,
  createMattermostClientMock,
  fetchMattermostMeMock,
} = vi.hoisted(() => ({
    createMattermostClientMock: vi.fn(),
    fetchMattermostMeMock: vi.fn(),
    listMattermostAccountIdsMock: vi.fn(),
    resolveMattermostAccountMock: vi.fn(),
  }));

vi.mock("./accounts.js", () => ({
    listMattermostAccountIds: listMattermostAccountIdsMock,
    resolveMattermostAccount: resolveMattermostAccountMock,
  }));

vi.mock("./client.js", () => ({
    createMattermostClient: createMattermostClientMock,
    fetchMattermostMe: fetchMattermostMeMock,
  }));

let listMattermostDirectoryGroups: typeof import("./directory.js").listMattermostDirectoryGroups;
let listMattermostDirectoryPeers: typeof import("./directory.js").listMattermostDirectoryPeers;

describe("mattermost directory", () => {
  beforeAll(async () => {
    ({ listMattermostDirectoryGroups, listMattermostDirectoryPeers } =
      await import("./directory.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates channels across enabled accounts and skips failing accounts", async () => {
    const clientA = {
      request: vi.fn().mockResolvedValueOnce([
        { display_name: "Alerts", id: "chan-1", name: "alerts", type: "O" },
        { display_name: "Ops", id: "chan-2", name: "ops", type: "P" },
        { display_name: "Direct", id: "chan-3", name: "dm", type: "D" },
      ]),
      token: "token-a",
    };
    const clientB = {
      request: vi.fn().mockRejectedValue(new Error("expired token")),
      token: "token-b",
    };
    const clientC = {
      request: vi.fn().mockResolvedValueOnce([
        { display_name: "Ops", id: "chan-2", name: "ops", type: "P" },
        { display_name: "Infra", id: "chan-4", name: "infra", type: "O" },
      ]),
      token: "token-c",
    };

    listMattermostAccountIdsMock.mockReturnValue(["default", "alerts", "infra"]);
    resolveMattermostAccountMock.mockImplementation(({ accountId }) => {
      if (accountId === "disabled") {
        return { enabled: false };
      }
      return { baseUrl: "https://chat.example.com", botToken: `token-${accountId}`, enabled: true };
    });
    createMattermostClientMock
      .mockReturnValueOnce(clientA)
      .mockReturnValueOnce(clientB)
      .mockReturnValueOnce(clientC);
    fetchMattermostMeMock.mockResolvedValue({ id: "me-1" });

    await expect(
      listMattermostDirectoryGroups({
        cfg: {} as never,
        query: "  op  ",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ handle: "Ops", id: "channel:chan-2", kind: "group", name: "ops" }]);
  });

  it("uses the first healthy client for peers and filters self and blanks", async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce([{ id: "team-1" }])
        .mockResolvedValueOnce([{ user_id: "me-1" }, { user_id: "user-1" }, { user_id: "user-2" }])
        .mockResolvedValueOnce([
          {
            first_name: "Alice",
            id: "user-1",
            last_name: "Ng",
            username: "alice",
          },
          {
            id: "user-2",
            nickname: "Bobby",
            username: "bob",
          },
          {
            id: "me-1",
            username: "self",
          },
        ]),
      token: "token-default",
    };

    listMattermostAccountIdsMock.mockReturnValue(["default"]);
    resolveMattermostAccountMock.mockReturnValue({
      baseUrl: "https://chat.example.com",
      botToken: "token-default",
      enabled: true,
    });
    createMattermostClientMock.mockReturnValue(client);
    fetchMattermostMeMock.mockResolvedValue({ id: "me-1" });

    await expect(
      listMattermostDirectoryPeers({
        cfg: {} as never,
        runtime: {} as never,
      }),
    ).resolves.toEqual([
      { handle: "Alice Ng", id: "user:user-1", kind: "user", name: "alice" },
      { handle: "Bobby", id: "user:user-2", kind: "user", name: "bob" },
    ]);
  });

  it("uses user search when a query is present and applies limits", async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce([{ id: "team-1" }])
        .mockResolvedValueOnce([
          { first_name: "Alice", id: "user-1", last_name: "Ng", username: "alice" },
          { id: "user-2", nickname: "Lex", username: "alex" },
        ]),
      token: "token-default",
    };

    listMattermostAccountIdsMock.mockReturnValue(["default"]);
    resolveMattermostAccountMock.mockReturnValue({
      baseUrl: "https://chat.example.com",
      botToken: "token-default",
      enabled: true,
    });
    createMattermostClientMock.mockReturnValue(client);
    fetchMattermostMeMock.mockResolvedValue({ id: "me-1" });

    await expect(
      listMattermostDirectoryPeers({
        cfg: {} as never,
        limit: 1,
        query: "  ali  ",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ handle: "Alice Ng", id: "user:user-1", kind: "user", name: "alice" }]);

    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "/users/search",
      expect.objectContaining({
        body: JSON.stringify({ team_id: "team-1", term: "ali" }),
        method: "POST",
      }),
    );
  });
});
