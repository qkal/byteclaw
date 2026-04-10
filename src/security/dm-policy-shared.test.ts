import { describe, expect, it } from "vitest";
import {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmAllowState,
  resolveDmGroupAccessDecision,
  resolveDmGroupAccessWithCommandGate,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "./dm-policy-shared.js";

describe("security/dm-policy-shared", () => {
  const controlCommand = {
    allowTextCommands: true,
    hasControlCommand: true,
    useAccessGroups: true,
  } as const;

  async function expectStoreReadSkipped(params: {
    provider: string;
    accountId: string;
    dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
    shouldRead?: boolean;
  }) {
    let called = false;
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: params.provider,
      accountId: params.accountId,
      ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
      ...(params.shouldRead !== undefined ? { shouldRead: params.shouldRead } : {}),
      readStore: async (_provider, _accountId) => {
        called = true;
        return ["should-not-be-read"];
      },
    });
    expect(called).toBe(false);
    expect(storeAllowFrom).toEqual([]);
  }

  function resolveCommandGate(overrides: {
    isGroup: boolean;
    isSenderAllowed: (allowFrom: string[]) => boolean;
    groupPolicy?: "open" | "allowlist" | "disabled";
  }) {
    return resolveDmGroupAccessWithCommandGate({
      allowFrom: ["owner"],
      command: controlCommand,
      dmPolicy: "pairing",
      groupAllowFrom: ["group-owner"],
      groupPolicy: overrides.groupPolicy ?? "allowlist",
      storeAllowFrom: ["paired-user"],
      ...overrides,
    });
  }

  it("normalizes config + store allow entries and counts distinct senders", async () => {
    const state = await resolveDmAllowState({
      accountId: "default",
      allowFrom: [" * ", " alice ", "ALICE", "bob"],
      normalizeEntry: (value) => value.toLowerCase(),
      provider: "demo-channel-a" as never,
      readStore: async (_provider, _accountId) => [" Bob ", "carol", ""],
    });
    expect(state.configAllowFrom).toEqual(["*", "alice", "ALICE", "bob"]);
    expect(state.hasWildcard).toBe(true);
    expect(state.allowCount).toBe(3);
    expect(state.isMultiUserDm).toBe(true);
  });

  it("handles empty allowlists and store failures", async () => {
    const state = await resolveDmAllowState({
      accountId: "default",
      allowFrom: undefined,
      provider: "demo-channel-b" as never,
      readStore: async (_provider, _accountId) => {
        throw new Error("offline");
      },
    });
    expect(state.configAllowFrom).toEqual([]);
    expect(state.hasWildcard).toBe(false);
    expect(state.allowCount).toBe(0);
    expect(state.isMultiUserDm).toBe(false);
  });

  it.each([
    {
      name: "dmPolicy is allowlist",
      params: {
        accountId: "default",
        dmPolicy: "allowlist" as const,
        provider: "demo-channel-a",
      },
    },
    {
      name: "shouldRead=false",
      params: {
        accountId: "default",
        provider: "demo-channel-b",
        shouldRead: false,
      },
    },
  ] as const)("skips pairing-store reads when $name", async ({ params }) => {
    await expectStoreReadSkipped(params);
  });

  it("builds effective DM/group allowlists from config + pairing store", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: [" owner ", "", "owner2"],
      groupAllowFrom: ["group:abc"],
      storeAllowFrom: [" owner3 ", ""],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "owner2", "owner3"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc"]);
  });

  it("falls back to DM allowlist for groups when groupAllowFrom is empty", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: [" owner "],
      groupAllowFrom: [],
      storeAllowFrom: [" owner2 "],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "owner2"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["owner"]);
  });

  it("can keep group allowlist empty when fallback is disabled", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["owner"],
      groupAllowFrom: [],
      groupAllowFromFallbackToAllowFrom: false,
      storeAllowFrom: ["paired-user"],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
    expect(lists.effectiveGroupAllowFrom).toEqual([]);
  });

  it("infers pinned main DM owner from a single configured allowlist entry", () => {
    const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
      allowFrom: [" line:user:U123 "],
      dmScope: "main",
      normalizeEntry: (entry) =>
        entry
          .trim()
          .toLowerCase()
          .replace(/^line:(?:user:)?/, ""),
    });
    expect(pinnedOwner).toBe("u123");
  });

  it.each([
    {
      allowFrom: ["*"],
      dmScope: "main" as const,
      name: "wildcard allowlist",
    },
    {
      allowFrom: ["u123", "u456"],
      dmScope: "main" as const,
      name: "multi-owner allowlist",
    },
    {
      allowFrom: ["u123"],
      dmScope: "per-channel-peer" as const,
      name: "non-main scope",
    },
  ] as const)("does not infer pinned owner for $name", ({ dmScope, allowFrom }) => {
    expect(
      resolvePinnedMainDmOwnerFromAllowlist({
        allowFrom: [...allowFrom],
        dmScope,
        normalizeEntry: (entry) => entry.trim(),
      }),
    ).toBeNull();
  });

  it("excludes storeAllowFrom when dmPolicy is allowlist", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["+1111"],
      dmPolicy: "allowlist",
      groupAllowFrom: ["group:abc"],
      storeAllowFrom: ["+2222", "+3333"],
    });
    expect(lists.effectiveAllowFrom).toEqual(["+1111"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc"]);
  });

  it("keeps group allowlist explicit when dmPolicy is pairing", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["+1111"],
      dmPolicy: "pairing",
      groupAllowFrom: [],
      storeAllowFrom: ["+2222"],
    });
    expect(lists.effectiveAllowFrom).toEqual(["+1111", "+2222"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["+1111"]);
  });

  it("resolves access + effective allowlists in one shared call", () => {
    const resolved = resolveDmGroupAccessWithLists({
      allowFrom: ["owner"],
      dmPolicy: "pairing",
      groupAllowFrom: ["group:room"],
      groupPolicy: "allowlist",
      isGroup: false,
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
      storeAllowFrom: ["paired-user"],
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED);
    expect(resolved.reason).toBe("dmPolicy=pairing (allowlisted)");
    expect(resolved.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
    expect(resolved.effectiveGroupAllowFrom).toEqual(["group:room"]);
  });

  it("resolves command gate with dm/group parity for groups", () => {
    const resolved = resolveCommandGate({
      isGroup: true,
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
    });
    expect(resolved.decision).toBe("block");
    expect(resolved.reason).toBe("groupPolicy=allowlist (not allowlisted)");
    expect(resolved.commandAuthorized).toBe(false);
    expect(resolved.shouldBlockControlCommand).toBe(true);
  });

  it("keeps configured dm allowlist usable for group command auth", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      allowFrom: ["owner"],
      command: controlCommand,
      dmPolicy: "pairing",
      groupAllowFrom: [],
      groupPolicy: "open",
      isGroup: true,
      isSenderAllowed: (allowFrom) => allowFrom.includes("owner"),
      storeAllowFrom: ["paired-user"],
    });
    expect(resolved.commandAuthorized).toBe(true);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("treats dm command authorization as dm access result", () => {
    const resolved = resolveCommandGate({
      isGroup: false,
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.commandAuthorized).toBe(true);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("does not auto-authorize dm commands in open mode without explicit allowlists", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      allowFrom: [],
      command: controlCommand,
      dmPolicy: "open",
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      isGroup: false,
      isSenderAllowed: () => false,
      storeAllowFrom: [],
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.commandAuthorized).toBe(false);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("keeps allowlist mode strict in shared resolver (no pairing-store fallback)", () => {
    const resolved = resolveDmGroupAccessWithLists({
      allowFrom: ["owner"],
      dmPolicy: "allowlist",
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      isGroup: false,
      isSenderAllowed: () => false,
      storeAllowFrom: ["paired-user"],
    });
    expect(resolved.decision).toBe("block");
    expect(resolved.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED);
    expect(resolved.reason).toBe("dmPolicy=allowlist (not allowlisted)");
    expect(resolved.effectiveAllowFrom).toEqual(["owner"]);
  });

  const channels = [
    "bluebubbles",
    "imessage",
    "signal",
    "telegram",
    "whatsapp",
    "msteams",
    "matrix",
    "zalo",
  ] as const;

  interface ParityCase {
    name: string;
    isGroup: boolean;
    dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
    groupPolicy: "open" | "allowlist" | "disabled";
    allowFrom: string[];
    groupAllowFrom: string[];
    storeAllowFrom: string[];
    isSenderAllowed: (allowFrom: string[]) => boolean;
    expectedDecision: "allow" | "block" | "pairing";
    expectedReactionAllowed: boolean;
  }

  interface DecisionCase {
    name: string;
    input: Parameters<typeof resolveDmGroupAccessDecision>[0];
    expected:
      | ReturnType<typeof resolveDmGroupAccessDecision>
      | Pick<ReturnType<typeof resolveDmGroupAccessDecision>, "decision">;
  }

  function createParityCase({
    name,
    ...overrides
  }: Partial<ParityCase> & Pick<ParityCase, "name">): ParityCase {
    return {
      allowFrom: [],
      dmPolicy: "open",
      expectedDecision: "allow",
      expectedReactionAllowed: true,
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      isGroup: false,
      isSenderAllowed: () => false,
      name,
      storeAllowFrom: [],
      ...overrides,
    };
  }

  function expectParityCase(channel: (typeof channels)[number], testCase: ParityCase) {
    const access = resolveDmGroupAccessWithLists({
      allowFrom: testCase.allowFrom,
      dmPolicy: testCase.dmPolicy,
      groupAllowFrom: testCase.groupAllowFrom,
      groupPolicy: testCase.groupPolicy,
      isGroup: testCase.isGroup,
      isSenderAllowed: testCase.isSenderAllowed,
      storeAllowFrom: testCase.storeAllowFrom,
    });
    const reactionAllowed = access.decision === "allow";
    expect(access.decision, `[${channel}] ${testCase.name}`).toBe(testCase.expectedDecision);
    expect(reactionAllowed, `[${channel}] ${testCase.name} reaction`).toBe(
      testCase.expectedReactionAllowed,
    );
  }

  it.each(
    channels.flatMap((channel) =>
      [
        createParityCase({
          dmPolicy: "open",
          expectedDecision: "allow",
          expectedReactionAllowed: true,
          name: "dmPolicy=open",
        }),
        createParityCase({
          dmPolicy: "disabled",
          expectedDecision: "block",
          expectedReactionAllowed: false,
          name: "dmPolicy=disabled",
        }),
        createParityCase({
          allowFrom: ["owner"],
          dmPolicy: "allowlist",
          expectedDecision: "block",
          expectedReactionAllowed: false,
          isSenderAllowed: () => false,
          name: "dmPolicy=allowlist unauthorized",
        }),
        createParityCase({
          allowFrom: ["owner"],
          dmPolicy: "allowlist",
          expectedDecision: "allow",
          expectedReactionAllowed: true,
          isSenderAllowed: () => true,
          name: "dmPolicy=allowlist authorized",
        }),
        createParityCase({
          dmPolicy: "pairing",
          expectedDecision: "pairing",
          expectedReactionAllowed: false,
          isSenderAllowed: () => false,
          name: "dmPolicy=pairing unauthorized",
        }),
        createParityCase({
          allowFrom: ["owner"],
          dmPolicy: "pairing",
          expectedDecision: "block",
          expectedReactionAllowed: false,
          groupAllowFrom: ["group-owner"],
          isGroup: true,
          isSenderAllowed: (allowFrom: string[]) => allowFrom.includes("paired-user"),
          name: "groupPolicy=allowlist rejects DM-paired sender not in explicit group list",
          storeAllowFrom: ["paired-user"],
        }),
      ].map((testCase) => ({
        channel,
        testCase,
      })),
    ),
  )(
    "keeps message/reaction policy parity table across channels: [$channel] $testCase.name",
    ({ channel, testCase }) => {
      expectParityCase(channel, testCase);
    },
  );

  const decisionCases: DecisionCase[] = [
    {
      expected: {
        decision: "block",
        reason: "groupPolicy=allowlist (empty allowlist)",
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
      },
      input: {
        dmPolicy: "pairing",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: [],
        groupPolicy: "allowlist",
        isGroup: true,
        isSenderAllowed: () => false,
      },
      name: "blocks groups when group allowlist is empty",
    },
    {
      expected: {
        decision: "allow",
        reason: "groupPolicy=open",
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
      },
      input: {
        dmPolicy: "pairing",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: [],
        groupPolicy: "open",
        isGroup: true,
        isSenderAllowed: () => false,
      },
      name: "allows groups when group policy is open",
    },
    {
      expected: {
        decision: "block",
        reason: "dmPolicy=allowlist (not allowlisted)",
        reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
      },
      input: {
        dmPolicy: "allowlist",
        effectiveAllowFrom: [],
        effectiveGroupAllowFrom: [],
        groupPolicy: "allowlist",
        isGroup: false,
        isSenderAllowed: () => false,
      },
      name: "blocks DM allowlist mode when allowlist is empty",
    },
    {
      expected: {
        decision: "pairing",
        reason: "dmPolicy=pairing (not allowlisted)",
        reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
      },
      input: {
        dmPolicy: "pairing",
        effectiveAllowFrom: [],
        effectiveGroupAllowFrom: [],
        groupPolicy: "allowlist",
        isGroup: false,
        isSenderAllowed: () => false,
      },
      name: "uses pairing flow when DM sender is not allowlisted",
    },
    {
      expected: {
        decision: "allow",
      },
      input: {
        dmPolicy: "allowlist",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: [],
        groupPolicy: "allowlist",
        isGroup: false,
        isSenderAllowed: () => true,
      },
      name: "allows DM sender when allowlisted",
    },
    {
      expected: {
        decision: "block",
        reason: "groupPolicy=allowlist (not allowlisted)",
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
      },
      input: {
        dmPolicy: "pairing",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: ["group:abc"],
        groupPolicy: "allowlist",
        isGroup: true,
        isSenderAllowed: () => false,
      },
      name: "blocks group allowlist mode when sender/group is not allowlisted",
    },
  ];

  it.each(
    channels.flatMap((channel) =>
      decisionCases.map((testCase) => ({
        channel,
        testCase,
      })),
    ),
  )("[$channel] $testCase.name", ({ testCase }) => {
    const decision = resolveDmGroupAccessDecision(testCase.input);
    if ("reasonCode" in testCase.expected && "reason" in testCase.expected) {
      expect(decision).toEqual(testCase.expected);
      return;
    }
    expect(decision).toMatchObject(testCase.expected);
  });
});
