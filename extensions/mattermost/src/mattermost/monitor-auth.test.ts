import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const evaluateSenderGroupAccessForPolicy = vi.hoisted(() => vi.fn());
const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveAllowlistMatchSimple = vi.hoisted(() => vi.fn());
const resolveControlCommandGate = vi.hoisted(() => vi.fn());
const resolveEffectiveAllowFromLists = vi.hoisted(() => vi.fn());

vi.mock("./runtime-api.js", () => ({
  evaluateSenderGroupAccessForPolicy,
  isDangerousNameMatchingEnabled,
  resolveAllowlistMatchSimple,
  resolveControlCommandGate,
  resolveEffectiveAllowFromLists,
}));

describe("mattermost monitor auth", () => {
  let authorizeMattermostCommandInvocation: typeof import("./monitor-auth.js").authorizeMattermostCommandInvocation;
  let isMattermostSenderAllowed: typeof import("./monitor-auth.js").isMattermostSenderAllowed;
  let normalizeMattermostAllowEntry: typeof import("./monitor-auth.js").normalizeMattermostAllowEntry;
  let normalizeMattermostAllowList: typeof import("./monitor-auth.js").normalizeMattermostAllowList;
  let resolveMattermostEffectiveAllowFromLists: typeof import("./monitor-auth.js").resolveMattermostEffectiveAllowFromLists;

  beforeAll(async () => {
    ({
      authorizeMattermostCommandInvocation,
      isMattermostSenderAllowed,
      normalizeMattermostAllowEntry,
      normalizeMattermostAllowList,
      resolveMattermostEffectiveAllowFromLists,
    } = await import("./monitor-auth.js"));
  });

  beforeEach(() => {
    evaluateSenderGroupAccessForPolicy.mockReset();
    isDangerousNameMatchingEnabled.mockReset();
    resolveAllowlistMatchSimple.mockReset();
    resolveControlCommandGate.mockReset();
    resolveEffectiveAllowFromLists.mockReset();
  });

  it("normalizes allowlist entries and resolves effective lists", () => {
    resolveEffectiveAllowFromLists.mockReturnValue({
      effectiveAllowFrom: ["alice"],
      effectiveGroupAllowFrom: ["team"],
    });

    expect(normalizeMattermostAllowEntry(" @Alice ")).toBe("alice");
    expect(normalizeMattermostAllowEntry("mattermost:Bob")).toBe("bob");
    expect(normalizeMattermostAllowEntry("*")).toBe("*");
    expect(normalizeMattermostAllowList([" Alice ", "user:alice", "ALICE", "*"])).toEqual([
      "alice",
      "*",
    ]);
    expect(
      resolveMattermostEffectiveAllowFromLists({
        allowFrom: [" Alice "],
        dmPolicy: "pairing",
        groupAllowFrom: [" Team "],
        storeAllowFrom: ["Store"],
      }),
    ).toEqual({
      effectiveAllowFrom: ["alice"],
      effectiveGroupAllowFrom: ["team"],
    });
    expect(resolveEffectiveAllowFromLists).toHaveBeenCalledWith({
      allowFrom: ["alice"],
      dmPolicy: "pairing",
      groupAllowFrom: ["team"],
      storeAllowFrom: ["store"],
    });
  });

  it("checks sender allowlists against normalized ids and names", () => {
    resolveAllowlistMatchSimple.mockReturnValue({ allowed: true });
    expect(
      isMattermostSenderAllowed({
        allowFrom: [" mattermost:alice "],
        allowNameMatching: true,
        senderId: "@Alice",
        senderName: "Alice",
      }),
    ).toBe(true);
    expect(resolveAllowlistMatchSimple).toHaveBeenCalledWith({
      allowFrom: ["alice"],
      allowNameMatching: true,
      senderId: "alice",
      senderName: "alice",
    });
  });

  it("authorizes direct messages in open mode and blocks disabled/group-restricted channels", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(false);
    resolveEffectiveAllowFromLists.mockReturnValue({
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    });
    resolveControlCommandGate.mockReturnValue({
      commandAuthorized: false,
      shouldBlock: false,
    });
    evaluateSenderGroupAccessForPolicy.mockReturnValue({
      allowed: false,
      reason: "empty_allowlist",
    });
    resolveAllowlistMatchSimple.mockReturnValue({ allowed: false });

    expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "open" },
        } as never,
        allowTextCommands: false,
        cfg: {} as never,
        channelId: "dm-1",
        channelInfo: { display_name: "Alice", name: "alice", type: "D" } as never,
        hasControlCommand: false,
        senderId: "alice",
        senderName: "Alice",
      }),
    ).toMatchObject({
      commandAuthorized: true,
      kind: "direct",
      ok: true,
      roomLabel: "#alice",
    });

    expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "disabled" },
        } as never,
        allowTextCommands: false,
        cfg: {} as never,
        channelId: "dm-1",
        channelInfo: { display_name: "Alice", name: "alice", type: "D" } as never,
        hasControlCommand: false,
        senderId: "alice",
        senderName: "Alice",
      }),
    ).toMatchObject({
      denyReason: "dm-disabled",
      ok: false,
    });

    expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { groupPolicy: "allowlist" },
        } as never,
        allowTextCommands: true,
        cfg: {} as never,
        channelId: "chan-1",
        channelInfo: { display_name: "Town Square", name: "town-square", type: "O" } as never,
        hasControlCommand: false,
        senderId: "alice",
        senderName: "Alice",
      }),
    ).toMatchObject({
      denyReason: "channel-no-allowlist",
      kind: "channel",
      ok: false,
    });
  });
});
