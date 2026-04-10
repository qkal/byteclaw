import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProviderMock,
  readAccessTokenMock,
  resolveMSTeamsCredentialsMock,
} = vi.hoisted(() => ({
    createMSTeamsTokenProviderMock: vi.fn(),
    loadMSTeamsSdkWithAuthMock: vi.fn(),
    readAccessTokenMock: vi.fn(),
    resolveMSTeamsCredentialsMock: vi.fn(),
  }));

vi.mock("./sdk.js", () => ({
  createMSTeamsTokenProvider: createMSTeamsTokenProviderMock,
  loadMSTeamsSdkWithAuth: loadMSTeamsSdkWithAuthMock,
}));

vi.mock("./token-response.js", () => ({
  readAccessToken: readAccessTokenMock,
}));

vi.mock("./token.js", () => ({
  resolveMSTeamsCredentials: resolveMSTeamsCredentialsMock,
}));

import { searchGraphUsers } from "./graph-users.js";
import {
  deleteGraphRequest,
  escapeOData,
  fetchGraphJson,
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  postGraphBetaJson,
  postGraphJson,
  resolveGraphToken,
} from "./graph.js";

const originalFetch = globalThis.fetch;
const graphToken = "graph-token";
const mockCredentials = {
  appId: "app-id",
  appPassword: "app-password",
  tenantId: "tenant-id",
};
const mockApp = { id: "mock-app" };
const groupOne = { id: "group-1" };
const opsTeam = { displayName: "Ops", id: "team-1" };
const deploymentsChannel = { displayName: "Deployments", id: "chan-1" };
const userOne = { displayName: "User One", id: "user-1" };
const bobUser = { displayName: "Bob", id: "user-2" };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

function mockFetch(handler: Parameters<typeof vi.fn>[0]) {
  globalThis.fetch = vi.fn(handler) as unknown as typeof fetch;
}

function mockJsonFetchResponse(body: unknown, init?: ResponseInit) {
  mockFetch(async () => jsonResponse(body, init));
}

function mockTextFetchResponse(body: string, init?: ResponseInit) {
  mockFetch(async () => textResponse(body, init));
}

function graphCollection<T>(...items: T[]) {
  return { value: items };
}

function mockGraphCollection<T>(...items: T[]) {
  mockJsonFetchResponse(graphCollection(...items));
}

function requestUrl(input: string | URL | Request) {
  return typeof input === "string" ? input : String(input);
}

function fetchCallUrl(index: number) {
  return String(vi.mocked(globalThis.fetch).mock.calls[index]?.[0]);
}

function expectFetchPathContains(index: number, expectedPath: string) {
  expect(fetchCallUrl(index)).toContain(expectedPath);
}

async function expectSearchGraphUsers(
  query: string,
  expected: Record<string, unknown>[],
  options?: { token?: string; top?: number },
) {
  await expect(
    searchGraphUsers({
      query,
      token: options?.token ?? graphToken,
      top: options?.top,
    }),
  ).resolves.toEqual(expected);
}

async function expectRejectsToThrow(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(message);
}

function mockGraphTokenResolution(options?: {
  rawToken?: string | null;
  resolvedToken?: string | null;
}) {
  const rawToken = options && "rawToken" in options ? options.rawToken : "raw-graph-token";
  const resolvedToken =
    options && "resolvedToken" in options ? options.resolvedToken : "resolved-token";
  const getAccessToken = vi.fn(async () => rawToken);
  loadMSTeamsSdkWithAuthMock.mockResolvedValue({ app: mockApp });
  createMSTeamsTokenProviderMock.mockReturnValue({ getAccessToken });
  resolveMSTeamsCredentialsMock.mockReturnValue(mockCredentials);
  readAccessTokenMock.mockReturnValue(resolvedToken);
  return { getAccessToken };
}

describe("msteams graph helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes queries and escapes OData apostrophes", () => {
    expect(normalizeQuery("  Team Alpha  ")).toBe("Team Alpha");
    expect(normalizeQuery("   ")).toBe("");
    expect(escapeOData("alice.o'hara")).toBe("alice.o''hara");
  });

  it("fetches Graph JSON and surfaces Graph errors with response text", async () => {
    mockGraphCollection(groupOne);

    await expect(
      fetchGraphJson<{ value: { id: string }[] }>({
        headers: { ConsistencyLevel: "eventual" },
        path: "/groups?$select=id",
        token: graphToken,
      }),
    ).resolves.toEqual(graphCollection(groupOne));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/groups?$select=id",
      {
        headers: expect.objectContaining({
          Authorization: `Bearer ${graphToken}`,
          ConsistencyLevel: "eventual",
        }),
      },
    );

    mockTextFetchResponse("forbidden", { status: 403 });

    await expectRejectsToThrow(
      fetchGraphJson({
        path: "/teams/team-1/channels",
        token: graphToken,
      }),
      "Graph /teams/team-1/channels failed (403): forbidden",
    );
  });

  it("posts Graph JSON to v1 and beta roots and treats empty mutation responses as undefined", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).startsWith("https://graph.microsoft.com/beta")) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ id: "created-1" });
    });

    await expect(
      postGraphJson<{ id: string }>({
        body: { messageId: "msg-1" },
        path: "/chats/chat-1/pinnedMessages",
        token: graphToken,
      }),
    ).resolves.toEqual({ id: "created-1" });

    await expect(
      postGraphBetaJson<undefined>({
        body: { reactionType: "like" },
        path: "/chats/chat-1/messages/msg-1/setReaction",
        token: graphToken,
      }),
    ).resolves.toBeUndefined();

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://graph.microsoft.com/v1.0/chats/chat-1/pinnedMessages",
      expect.objectContaining({
        body: JSON.stringify({ messageId: "msg-1" }),
        headers: expect.objectContaining({
          Authorization: `Bearer ${graphToken}`,
          "Content-Type": "application/json",
        }),
        method: "POST",
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://graph.microsoft.com/beta/chats/chat-1/messages/msg-1/setReaction",
      expect.objectContaining({
        body: JSON.stringify({ reactionType: "like" }),
        method: "POST",
      }),
    );
  });

  it("surfaces POST and DELETE graph failures with method-specific labels", async () => {
    mockFetch(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        return textResponse("not found", { status: 404 });
      }
      return textResponse("denied", { status: 403 });
    });

    await expectRejectsToThrow(
      postGraphJson({
        body: { displayName: "Deployments" },
        path: "/teams/team-1/channels",
        token: graphToken,
      }),
      "Graph POST /teams/team-1/channels failed (403): denied",
    );

    await expectRejectsToThrow(
      deleteGraphRequest({
        path: "/teams/team-1/channels/channel-1",
        token: graphToken,
      }),
      "Graph DELETE /teams/team-1/channels/channel-1 failed (404): not found",
    );
  });

  it("resolves Graph tokens through the SDK auth provider", async () => {
    const { getAccessToken } = mockGraphTokenResolution();

    await expect(resolveGraphToken({ channels: { msteams: {} } })).resolves.toBe("resolved-token");

    expect(createMSTeamsTokenProviderMock).toHaveBeenCalledWith(mockApp);
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
  });

  it("fails when credentials or access tokens are unavailable", async () => {
    resolveMSTeamsCredentialsMock.mockReturnValue(undefined);
    await expectRejectsToThrow(resolveGraphToken({ channels: {} }), "MS Teams credentials missing");

    mockGraphTokenResolution({ rawToken: null, resolvedToken: null });

    await expectRejectsToThrow(
      resolveGraphToken({ channels: { msteams: {} } }),
      "MS Teams graph token unavailable",
    );
  });

  it("builds encoded Graph paths for teams and channels", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).includes("/groups?")) {
        return jsonResponse(graphCollection(opsTeam));
      }
      return jsonResponse(graphCollection(deploymentsChannel));
    });

    await expect(listTeamsByName(graphToken, "Bob's Team")).resolves.toEqual([opsTeam]);
    await expect(listChannelsForTeam(graphToken, "team/ops")).resolves.toEqual([
      deploymentsChannel,
    ]);

    expectFetchPathContains(
      0,
      "/groups?$filter=resourceProvisioningOptions%2FAny(x%3Ax%20eq%20'Team')%20and%20startsWith(displayName%2C'Bob''s%20Team')&$select=id,displayName",
    );
    expectFetchPathContains(1, "/teams/team%2Fops/channels?$select=id,displayName");
  });

  it("returns no graph users for blank queries", async () => {
    mockJsonFetchResponse({});
    await expectSearchGraphUsers("   ", [], { token: "token-1" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses exact mail or UPN lookup for email-like graph user queries", async () => {
    mockGraphCollection(userOne);

    await expectSearchGraphUsers("alice.o'hara@example.com", [userOne], {
      token: "token-2",
    });
    expectFetchPathContains(
      0,
      "/users?$filter=(mail%20eq%20'alice.o''hara%40example.com'%20or%20userPrincipalName%20eq%20'alice.o''hara%40example.com')&$select=id,displayName,mail,userPrincipalName",
    );
  });

  it("uses displayName search with eventual consistency and default top handling", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).includes("displayName%3Abob")) {
        return jsonResponse(graphCollection(bobUser));
      }
      return jsonResponse({});
    });

    await expectSearchGraphUsers("bob", [bobUser], {
      token: "token-3",
      top: 25,
    });
    await expectSearchGraphUsers("carol", [], { token: "token-4" });

    const {calls} = vi.mocked(globalThis.fetch).mock;
    expectFetchPathContains(
      0,
      "/users?$search=%22displayName%3Abob%22&$select=id,displayName,mail,userPrincipalName&$top=25",
    );
    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ ConsistencyLevel: "eventual" }),
      }),
    );
    expectFetchPathContains(
      1,
      "/users?$search=%22displayName%3Acarol%22&$select=id,displayName,mail,userPrincipalName&$top=10",
    );
  });
});
