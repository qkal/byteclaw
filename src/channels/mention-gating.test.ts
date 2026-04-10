import { describe, expect, it } from "vitest";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
  resolveMentionGating,
  resolveMentionGatingWithBypass,
} from "./mention-gating.js";

describe("resolveMentionGating", () => {
  it("combines explicit, implicit, and bypass mentions", () => {
    const res = resolveMentionGating({
      canDetectMention: true,
      implicitMention: true,
      requireMention: true,
      shouldBypassMention: false,
      wasMentioned: false,
    });
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("skips when mention required and none detected", () => {
    const res = resolveMentionGating({
      canDetectMention: true,
      implicitMention: false,
      requireMention: true,
      shouldBypassMention: false,
      wasMentioned: false,
    });
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("does not skip when mention detection is unavailable", () => {
    const res = resolveMentionGating({
      canDetectMention: false,
      requireMention: true,
      wasMentioned: false,
    });
    expect(res.shouldSkip).toBe(false);
  });
});

describe("resolveMentionGatingWithBypass", () => {
  it.each([
    {
      commandAuthorized: true,
      name: "enables bypass when control commands are authorized",
      shouldBypassMention: true,
      shouldSkip: false,
    },
    {
      commandAuthorized: false,
      name: "does not bypass when control commands are not authorized",
      shouldBypassMention: false,
      shouldSkip: true,
    },
  ])("$name", ({ commandAuthorized, shouldBypassMention, shouldSkip }) => {
    const res = resolveMentionGatingWithBypass({
      allowTextCommands: true,
      canDetectMention: true,
      commandAuthorized,
      hasAnyMention: false,
      hasControlCommand: true,
      isGroup: true,
      requireMention: true,
      wasMentioned: false,
    });
    expect(res.shouldBypassMention).toBe(shouldBypassMention);
    expect(res.shouldSkip).toBe(shouldSkip);
  });
});

describe("resolveInboundMentionDecision", () => {
  it("allows matching implicit mention kinds by default", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        implicitMentionKinds: ["reply_to_bot"],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized: false,
        hasControlCommand: false,
        isGroup: true,
        requireMention: true,
      },
    });
    expect(res.implicitMention).toBe(true);
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("filters implicit mention kinds through the allowlist", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        implicitMentionKinds: ["reply_to_bot", "bot_thread_participant"],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        allowedImplicitMentionKinds: ["reply_to_bot"],
        commandAuthorized: false,
        hasControlCommand: false,
        isGroup: true,
        requireMention: true,
      },
    });
    expect(res.implicitMention).toBe(true);
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
    expect(res.shouldSkip).toBe(false);
  });

  it("blocks implicit mention kinds excluded by policy", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        implicitMentionKinds: ["reply_to_bot"],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        allowedImplicitMentionKinds: [],
        commandAuthorized: false,
        hasControlCommand: false,
        isGroup: true,
        requireMention: true,
      },
    });
    expect(res.implicitMention).toBe(false);
    expect(res.matchedImplicitMentionKinds).toEqual([]);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("dedupes repeated implicit mention kinds", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        implicitMentionKinds: ["reply_to_bot", "reply_to_bot", "native"],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized: false,
        hasControlCommand: false,
        isGroup: true,
        requireMention: true,
      },
    });
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot", "native"]);
  });

  it("keeps command bypass behavior unchanged", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        hasAnyMention: false,
        implicitMentionKinds: [],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized: true,
        hasControlCommand: true,
        isGroup: true,
        requireMention: true,
      },
    });
    expect(res.shouldBypassMention).toBe(true);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("does not allow command bypass when some other mention is present", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        hasAnyMention: true,
        implicitMentionKinds: [],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized: true,
        hasControlCommand: true,
        isGroup: true,
        requireMention: true,
      },
    });
    expect(res.shouldBypassMention).toBe(false);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("does not allow command bypass outside groups", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        hasAnyMention: false,
        implicitMentionKinds: [],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized: true,
        hasControlCommand: true,
        isGroup: false,
        requireMention: true,
      },
    });
    expect(res.shouldBypassMention).toBe(false);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("does not skip when mention detection is unavailable", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: false,
        implicitMentionKinds: [],
        wasMentioned: false,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized: false,
        hasControlCommand: false,
        isGroup: true,
        requireMention: true,
      },
    });
    expect(res.shouldSkip).toBe(false);
  });

  it("keeps the flat call shape for compatibility", () => {
    const res = resolveInboundMentionDecision({
      allowTextCommands: true,
      canDetectMention: true,
      commandAuthorized: false,
      hasControlCommand: false,
      implicitMentionKinds: ["reply_to_bot"],
      isGroup: true,
      requireMention: true,
      wasMentioned: false,
    });
    expect(res.effectiveWasMentioned).toBe(true);
  });
});

describe("implicitMentionKindWhen", () => {
  it("returns a one-item list when enabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", true)).toEqual(["reply_to_bot"]);
  });

  it("returns an empty list when disabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", false)).toEqual([]);
  });
});
