import { describe, expect, it } from "vitest";
import {
  COMMAND,
  COMMAND_KILL,
  COMMAND_STEER,
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
} from "./commands-subagents-dispatch.js";
import type { HandleCommandsParams } from "./commands-types.js";

function buildParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const normalized = commandBody.trim();
  const ctx = {
    CommandSource: "text",
    Provider: "whatsapp",
    SessionKey: "agent:main:main",
    Surface: "whatsapp",
    ...ctxOverrides,
  };

  return {
    cfg: {},
    command: {
      channel: String(ctx.Surface ?? "whatsapp"),
      channelId: String(ctx.Surface ?? "whatsapp"),
      commandBodyNormalized: normalized,
      from: "test-user",
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: normalized,
      senderId: "owner",
      senderIsOwner: true,
      surface: String(ctx.Surface ?? "whatsapp"),
      to: "test-bot",
    },
    contextTokens: 0,
    ctx,
    defaultGroupActivation: () => "mention",
    directives: {} as HandleCommandsParams["directives"],
    elevated: { allowed: true, enabled: true, failures: [] },
    isGroup: false,
    model: "test-model",
    provider: String(ctx.Provider ?? "whatsapp"),
    resolveDefaultThinkingLevel: async () => undefined,
    resolvedReasoningLevel: "off",
    resolvedVerboseLevel: "off",
    sessionKey: String(ctx.SessionKey ?? "agent:main:main"),
    workspaceDir: "/tmp/openclaw-commands-subagents",
  } as unknown as HandleCommandsParams;
}

describe("subagents command dispatch", () => {
  it("prefers native command target session keys", () => {
    const params = buildParams("/subagents list", {
      CommandSource: "native",
      CommandTargetSessionKey: "agent:main:main",
      SessionKey: "agent:main:slack:slash:u1",
    });
    expect(resolveRequesterSessionKey(params)).toBe("agent:main:main");
  });

  it("falls back to the current session for text commands", () => {
    const params = buildParams("/subagents list", {
      CommandSource: "text",
      CommandTargetSessionKey: "agent:main:main",
      SessionKey: "agent:main:whatsapp:direct:u1",
    });
    expect(resolveRequesterSessionKey(params)).toBe("agent:main:whatsapp:direct:u1");
  });

  it("maps slash aliases to the right handled prefix", () => {
    expect(resolveHandledPrefix("/subagents list")).toBe(COMMAND);
    expect(resolveHandledPrefix("/kill 1")).toBe(COMMAND_KILL);
    expect(resolveHandledPrefix("/steer 1 continue")).toBe(COMMAND_STEER);
    expect(resolveHandledPrefix("/unknown")).toBeNull();
  });

  it("maps prefixes and args to subagent actions", () => {
    const listTokens = ["list"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens: listTokens })).toBe("list");
    expect(listTokens).toEqual([]);

    const killTokens = ["1"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND_KILL, restTokens: killTokens })).toBe(
      "kill",
    );
    expect(killTokens).toEqual(["1"]);

    const steerTokens = ["1", "continue"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND_STEER, restTokens: steerTokens })).toBe(
      "steer",
    );
  });

  it("returns null for invalid /subagents actions", () => {
    const restTokens = ["foo"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens })).toBeNull();
    expect(restTokens).toEqual(["foo"]);
  });

  it("builds stop replies", () => {
    expect(stopWithText("hello")).toEqual({
      reply: { text: "hello" },
      shouldContinue: false,
    });
  });
});
