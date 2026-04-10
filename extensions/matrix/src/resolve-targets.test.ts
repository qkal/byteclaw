import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../runtime-api.js";

vi.mock("./directory-live.js", () => ({
  listMatrixDirectoryGroupsLive: vi.fn(),
  listMatrixDirectoryPeersLive: vi.fn(),
}));

let listMatrixDirectoryGroupsLive: typeof import("./directory-live.js").listMatrixDirectoryGroupsLive;
let listMatrixDirectoryPeersLive: typeof import("./directory-live.js").listMatrixDirectoryPeersLive;
let resolveMatrixTargets: typeof import("./resolve-targets.js").resolveMatrixTargets;

async function resolveUserTarget(input = "Alice") {
  const [result] = await resolveMatrixTargets({
    cfg: {},
    inputs: [input],
    kind: "user",
  });
  return result;
}

describe("resolveMatrixTargets (users)", () => {
  beforeAll(async () => {
    ({ listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } =
      await import("./directory-live.js"));
    ({ resolveMatrixTargets } = await import("./resolve-targets.js"));
  });

  beforeEach(() => {
    vi.mocked(listMatrixDirectoryPeersLive).mockReset();
    vi.mocked(listMatrixDirectoryGroupsLive).mockReset();
  });

  it("resolves exact unique display name matches", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { id: "@alice:example.org", kind: "user", name: "Alice" },
    ];
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue(matches);

    const result = await resolveUserTarget();

    expect(result?.resolved).toBe(true);
    expect(result?.id).toBe("@alice:example.org");
    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledWith({
      accountId: undefined,
      cfg: {},
      limit: 5,
      query: "Alice",
    });
  });

  it("does not resolve ambiguous or non-exact matches", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { id: "@alice:example.org", kind: "user", name: "Alice" },
      { id: "@alice:evil.example", kind: "user", name: "Alice" },
    ];
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue(matches);

    const result = await resolveUserTarget();

    expect(result?.resolved).toBe(false);
    expect(result?.note).toMatch(/use full Matrix ID/i);
  });

  it("prefers exact group matches over first partial result", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { handle: "#general", id: "!one:example.org", kind: "group", name: "General" },
      { handle: "#team", id: "!two:example.org", kind: "group", name: "Team" },
    ];
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue(matches);

    const [result] = await resolveMatrixTargets({
      cfg: {},
      inputs: ["#team"],
      kind: "group",
    });

    expect(result?.resolved).toBe(true);
    expect(result?.id).toBe("!two:example.org");
    expect(result?.note).toBeUndefined();
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledWith({
      accountId: undefined,
      cfg: {},
      limit: 5,
      query: "#team",
    });
  });

  it("threads accountId into live Matrix target lookups", async () => {
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue([
      { id: "@alice:example.org", kind: "user", name: "Alice" },
    ]);
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue([
      { handle: "#team", id: "!team:example.org", kind: "group", name: "Team" },
    ]);

    await resolveMatrixTargets({
      accountId: "ops",
      cfg: {},
      inputs: ["Alice"],
      kind: "user",
    });
    await resolveMatrixTargets({
      accountId: "ops",
      cfg: {},
      inputs: ["#team"],
      kind: "group",
    });

    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: {},
      limit: 5,
      query: "Alice",
    });
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: {},
      limit: 5,
      query: "#team",
    });
  });

  it("reuses directory lookups for normalized duplicate inputs", async () => {
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue([
      { id: "@alice:example.org", kind: "user", name: "Alice" },
    ]);
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue([
      { handle: "#team", id: "!team:example.org", kind: "group", name: "Team" },
    ]);

    const userResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["Alice", " alice "],
      kind: "user",
    });
    const groupResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["#team", "#team"],
      kind: "group",
    });

    expect(userResults.every((entry) => entry.resolved)).toBe(true);
    expect(groupResults.every((entry) => entry.resolved)).toBe(true);
    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledTimes(1);
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("accepts prefixed fully qualified ids without directory lookups", async () => {
    const userResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["matrix:user:@alice:example.org"],
      kind: "user",
    });
    const groupResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["matrix:room:!team:example.org"],
      kind: "group",
    });

    expect(userResults).toEqual([
      {
        id: "@alice:example.org",
        input: "matrix:user:@alice:example.org",
        resolved: true,
      },
    ]);
    expect(groupResults).toEqual([
      {
        id: "!team:example.org",
        input: "matrix:room:!team:example.org",
        resolved: true,
      },
    ]);
    expect(listMatrixDirectoryPeersLive).not.toHaveBeenCalled();
    expect(listMatrixDirectoryGroupsLive).not.toHaveBeenCalled();
  });
});
