import { describe, expect, it, vi } from "vitest";

const {
  listTeamsByName,
  listChannelsForTeam,
  normalizeQuery,
  resolveGraphToken,
  searchGraphUsers,
} = vi.hoisted(() => ({
  listChannelsForTeam: vi.fn(),
  listTeamsByName: vi.fn(),
  normalizeQuery: vi.fn((value: string) => value.trim().toLowerCase()),
  resolveGraphToken: vi.fn(async () => "graph-token"),
  searchGraphUsers: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  resolveGraphToken,
}));

vi.mock("./graph-users.js", () => ({
  searchGraphUsers,
}));

import {
  looksLikeMSTeamsTargetId,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

describe("resolveMSTeamsUserAllowlist", () => {
  it("marks empty input unresolved", async () => {
    const [result] = await resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["  "] });
    expect(result).toEqual({ input: "  ", resolved: false });
  });

  it("resolves first Graph user match", async () => {
    searchGraphUsers.mockResolvedValueOnce([
      { displayName: "Alice One", id: "user-1" },
      { displayName: "Alice Two", id: "user-2" },
    ]);
    const [result] = await resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["alice"] });
    expect(result).toEqual({
      id: "user-1",
      input: "alice",
      name: "Alice One",
      note: "multiple matches; chose first",
      resolved: true,
    });
  });
});

describe("resolveMSTeamsChannelAllowlist", () => {
  it("resolves team/channel by team name + channel display name", async () => {
    // After the fix, listChannelsForTeam is called once and reused for both
    // General channel resolution and channel matching.
    listTeamsByName.mockResolvedValueOnce([{ displayName: "Product Team", id: "team-guid-1" }]);
    listChannelsForTeam.mockResolvedValueOnce([
      { displayName: "General", id: "19:general-conv-id@thread.tacv2" },
      { displayName: "Roadmap", id: "19:roadmap-conv-id@thread.tacv2" },
    ]);

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Product Team/Roadmap"],
    });

    // TeamId is now the General channel's conversation ID — not the Graph GUID —
    // Because that's what Bot Framework sends as channelData.team.id at runtime.
    expect(result).toEqual({
      channelId: "19:roadmap-conv-id@thread.tacv2",
      channelName: "Roadmap",
      input: "Product Team/Roadmap",
      note: "multiple channels; chose first",
      resolved: true,
      teamId: "19:general-conv-id@thread.tacv2",
      teamName: "Product Team",
    });
  });

  it("uses General channel conversation ID as team key for team-only entry", async () => {
    // When no channel is specified we still resolve the General channel so the
    // Stored key matches what Bot Framework sends as channelData.team.id.
    listTeamsByName.mockResolvedValueOnce([{ displayName: "Engineering", id: "guid-engineering" }]);
    listChannelsForTeam.mockResolvedValueOnce([
      { displayName: "General", id: "19:eng-general@thread.tacv2" },
      { displayName: "Standups", id: "19:eng-standups@thread.tacv2" },
    ]);

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Engineering"],
    });

    expect(result).toEqual({
      input: "Engineering",
      resolved: true,
      teamId: "19:eng-general@thread.tacv2",
      teamName: "Engineering",
    });
  });

  it("falls back to Graph GUID when listChannelsForTeam throws", async () => {
    // Edge case: API call fails (rate limit, network error). We fall back to
    // The Graph GUID as the team key — the pre-fix behavior — so resolution
    // Still succeeds instead of propagating the error.
    listTeamsByName.mockResolvedValueOnce([{ displayName: "Flaky Team", id: "guid-flaky" }]);
    listChannelsForTeam.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Flaky Team"],
    });

    expect(result).toEqual({
      input: "Flaky Team",
      resolved: true,
      teamId: "guid-flaky",
      teamName: "Flaky Team",
    });
  });

  it("falls back to Graph GUID when General channel is not found", async () => {
    // Edge case: General channel was renamed or deleted. We fall back to the
    // Graph GUID so resolution still succeeds rather than silently breaking.
    listTeamsByName.mockResolvedValueOnce([{ displayName: "Operations", id: "guid-ops" }]);
    listChannelsForTeam.mockResolvedValueOnce([
      { displayName: "Announcements", id: "19:ops-announce@thread.tacv2" },
      { displayName: "Random", id: "19:ops-random@thread.tacv2" },
    ]);

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Operations"],
    });

    expect(result).toEqual({
      input: "Operations",
      resolved: true,
      teamId: "guid-ops",
      teamName: "Operations",
    });
  });
});

describe("looksLikeMSTeamsTargetId", () => {
  // Regression suite for https://github.com/openclaw/openclaw/issues/58001:
  // Cron announce delivery rejected valid Teams conversation ids because the
  // Validator only matched the `conversation:`-prefixed and `@thread`-suffixed
  // Forms. It must now accept every documented Bot Framework + Graph format.
  it.each([
    "conversation:19:abc@thread.tacv2",
    "conversation:a:1abc",
    "conversation:8:orgid:2d8c2d2c-1111-2222-3333-444444444444",
  ])("accepts conversation-prefixed ids (%s)", (raw) => {
    expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
  });

  it.each(["19:AdviChannelId@thread.tacv2", "19:abc@thread.tacv2", "19:abc@thread.skype"])(
    "accepts bare channel/group conversation ids (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
    },
  );

  it("accepts the Graph 1:1 chat thread format", () => {
    expect(
      looksLikeMSTeamsTargetId(
        "19:40a1a0ed4ff24164a21955518990c197_2d8c2d2c11112222@unq.gbl.spaces",
      ),
    ).toBe(true);
  });

  it.each(["a:1abc123def", "a:1xyz-abc_def", "A:1UPPER"])(
    "accepts Bot Framework personal chat ids (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
    },
  );

  it.each(["8:orgid:2d8c2d2c-1111-2222-3333-444444444444", "8:orgid:user-object-id"])(
    "accepts Bot Framework org-scoped personal chat ids (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
    },
  );

  it("accepts Bot Framework user ids", () => {
    expect(looksLikeMSTeamsTargetId("29:1a2b3c4d5e6f")).toBe(true);
  });

  it("accepts user:<aad-object-id> ids", () => {
    expect(looksLikeMSTeamsTargetId("user:40a1a0ed-4ff2-4164-a219-55518990c197")).toBe(true);
  });

  it.each(["", "   ", "user:John Smith", "Product Team/Roadmap", "Engineering", "hello"])(
    "rejects non-id inputs (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(false);
    },
  );

  it("normalizes leading/trailing whitespace before classifying", () => {
    expect(looksLikeMSTeamsTargetId("  19:abc@thread.tacv2  ")).toBe(true);
  });
});
