import { describe, expect, it } from "vitest";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import {
  getSubagentDepth,
  isCronSessionKey,
  parseThreadSessionSuffix,
  resolveThreadParentSessionKey,
} from "../sessions/session-key-utils.js";
import {
  classifySessionKeyShape,
  isValidAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "./session-key.js";

describe("classifySessionKeyShape", () => {
  it.each([
    { expected: "missing", input: undefined },
    { expected: "missing", input: "   " },
    { expected: "agent", input: "agent:main:main" },
    { expected: "agent", input: "agent:research:subagent:worker" },
    { expected: "malformed_agent", input: "agent::broken" },
    { expected: "malformed_agent", input: "agent:main" },
    { expected: "legacy_or_alias", input: "main" },
    { expected: "legacy_or_alias", input: "custom-main" },
    { expected: "legacy_or_alias", input: "subagent:worker" },
  ] as const)("classifies %j as $expected", ({ input, expected }) => {
    expect(classifySessionKeyShape(input)).toBe(expected);
  });
});

describe("session key backward compatibility", () => {
  function expectBackwardCompatibleDirectSessionKey(key: string) {
    expect(classifySessionKeyShape(key)).toBe("agent");
  }

  it.each([
    "agent:main:telegram:dm:123456",
    "agent:main:whatsapp:dm:+15551234567",
    "agent:main:discord:dm:user123",
    "agent:main:telegram:direct:123456",
    "agent:main:whatsapp:direct:+15551234567",
    "agent:main:discord:direct:user123",
  ] as const)("classifies backward-compatible direct session key %s as valid", (key) => {
    expectBackwardCompatibleDirectSessionKey(key);
  });
});

describe("getSubagentDepth", () => {
  it.each([
    { expected: 0, key: "agent:main:main" },
    { expected: 0, key: "main" },
    { expected: 0, key: undefined },
    { expected: 2, key: "agent:main:subagent:parent:subagent:child" },
  ] as const)("returns $expected for session key %j", ({ key, expected }) => {
    expect(getSubagentDepth(key)).toBe(expected);
  });
});

describe("isCronSessionKey", () => {
  it.each([
    { expected: true, key: "agent:main:cron:job-1" },
    { expected: true, key: "agent:main:cron:job-1:run:run-1" },
    { expected: false, key: "agent:main:main" },
    { expected: false, key: "agent:main:subagent:worker" },
    { expected: false, key: "cron:job-1" },
    { expected: false, key: undefined },
  ] as const)("matches cron key %j => $expected", ({ key, expected }) => {
    expect(isCronSessionKey(key)).toBe(expected);
  });
});

describe("deriveSessionChatTypeFromKey", () => {
  it.each([
    { expected: "direct", key: "agent:main:discord:direct:user1" },
    { expected: "group", key: "agent:main:telegram:group:g1" },
    { expected: "channel", key: "agent:main:discord:channel:c1" },
    { expected: "direct", key: "agent:main:telegram:dm:123456" },
    { expected: "direct", key: "telegram:dm:123456" },
    { expected: "channel", key: "discord:acc-1:guild-123:channel-456" },
    { expected: "group", key: "12345-678@g.us" },
    { expected: "unknown", key: "agent:main:main" },
    { expected: "unknown", key: "agent:main" },
    { expected: "unknown", key: "" },
  ] as const)("derives chat type for %j => $expected", ({ key, expected }) => {
    expect(deriveSessionChatTypeFromKey(key)).toBe(expected);
  });
});

describe("thread session suffix parsing", () => {
  it("preserves feishu conversation ids that embed :topic: in the base id", () => {
    expect(
      parseThreadSessionSuffix(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
    expect(
      resolveThreadParentSessionKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toBeNull();
  });

  it("does not treat telegram :topic: as a generic thread suffix", () => {
    expect(parseThreadSessionSuffix("agent:main:telegram:group:-100123:topic:77")).toEqual({
      baseSessionKey: "agent:main:telegram:group:-100123:topic:77",
      threadId: undefined,
    });
    expect(resolveThreadParentSessionKey("agent:main:telegram:group:-100123:topic:77")).toBeNull();
  });

  it("parses mixed-case :thread: markers without lowercasing the stored key", () => {
    expect(
      parseThreadSessionSuffix("agent:main:slack:channel:General:Thread:1699999999.0001"),
    ).toEqual({
      baseSessionKey: "agent:main:slack:channel:General",
      threadId: "1699999999.0001",
    });
  });
});

describe("session key canonicalization", () => {
  function expectSessionKeyCanonicalizationCase(params: { run: () => void }) {
    params.run();
  }

  it.each([
    {
      name: "parses agent keys case-insensitively and returns lowercase tokens",
      run: () =>
        expect(parseAgentSessionKey("AGENT:Main:Hook:Webhook:42")).toEqual({
          agentId: "main",
          rest: "hook:webhook:42",
        }),
    },
    {
      name: "does not double-prefix already-qualified agent keys",
      run: () =>
        expect(
          toAgentStoreSessionKey({
            agentId: "main",
            requestKey: "agent:main:main",
          }),
        ).toBe("agent:main:main"),
    },
  ] as const)("$name", ({ run }) => {
    expectSessionKeyCanonicalizationCase({ run });
  });
});

describe("isValidAgentId", () => {
  it.each([
    { expected: true, input: "main" },
    { expected: true, input: "my-research_agent01" },
    { expected: false, input: "" },
    { expected: false, input: "Agent not found: xyz" },
    { expected: false, input: "../../../etc/passwd" },
    { expected: false, input: "a".repeat(65) },
  ] as const)("validates agent id %j => $expected", ({ input, expected }) => {
    expect(isValidAgentId(input)).toBe(expected);
  });
});
