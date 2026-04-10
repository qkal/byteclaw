import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { getMemberInfoMSTeams } from "./graph-members.js";

const mockState = vi.hoisted(() => ({
  fetchGraphJson: vi.fn(),
  resolveGraphToken: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  fetchGraphJson: mockState.fetchGraphJson,
  resolveGraphToken: mockState.resolveGraphToken,
}));

const TOKEN = "test-graph-token";

describe("getMemberInfoMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("fetches user profile and maps all fields", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      displayName: "Alice Smith",
      id: "user-123",
      jobTitle: "Engineer",
      mail: "alice@contoso.com",
      officeLocation: "Building 1",
      userPrincipalName: "alice@contoso.com",
    });

    const result = await getMemberInfoMSTeams({
      cfg: {} as OpenClawConfig,
      userId: "user-123",
    });

    expect(result).toEqual({
      user: {
        displayName: "Alice Smith",
        id: "user-123",
        jobTitle: "Engineer",
        mail: "alice@contoso.com",
        officeLocation: "Building 1",
        userPrincipalName: "alice@contoso.com",
      },
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/users/${encodeURIComponent("user-123")}?$select=id,displayName,mail,jobTitle,userPrincipalName,officeLocation`,
      token: TOKEN,
    });
  });

  it("handles sparse data with some fields undefined", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      displayName: "Bob",
      id: "user-456",
    });

    const result = await getMemberInfoMSTeams({
      cfg: {} as OpenClawConfig,
      userId: "user-456",
    });

    expect(result).toEqual({
      user: {
        displayName: "Bob",
        id: "user-456",
        jobTitle: undefined,
        mail: undefined,
        officeLocation: undefined,
        userPrincipalName: undefined,
      },
    });
  });

  it("propagates Graph API errors", async () => {
    mockState.fetchGraphJson.mockRejectedValue(new Error("Graph API 404: user not found"));

    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        userId: "nonexistent-user",
      }),
    ).rejects.toThrow("Graph API 404: user not found");
  });
});
