import { describe, expect, it } from "vitest";
import { resolveNativeCommandSessionTargets } from "./native-command-session-targets.js";

describe("resolveNativeCommandSessionTargets", () => {
  it("uses the bound session for both targets when present", () => {
    expect(
      resolveNativeCommandSessionTargets({
        agentId: "codex",
        boundSessionKey: "agent:codex:acp:binding:discord:default:seed",
        sessionPrefix: "discord:slash",
        targetSessionKey: "agent:codex:discord:channel:chan-1",
        userId: "user-1",
      }),
    ).toEqual({
      commandTargetSessionKey: "agent:codex:acp:binding:discord:default:seed",
      sessionKey: "agent:codex:acp:binding:discord:default:seed",
    });
  });

  it("falls back to the routed session target when unbound", () => {
    expect(
      resolveNativeCommandSessionTargets({
        agentId: "qwen",
        sessionPrefix: "telegram:slash",
        targetSessionKey: "agent:qwen:telegram:direct:user-1",
        userId: "user-1",
      }),
    ).toEqual({
      commandTargetSessionKey: "agent:qwen:telegram:direct:user-1",
      sessionKey: "agent:qwen:telegram:slash:user-1",
    });
  });

  it("supports lowercase session keys for providers that already normalize", () => {
    expect(
      resolveNativeCommandSessionTargets({
        agentId: "Qwen",
        lowercaseSessionKey: true,
        sessionPrefix: "Slack:Slash",
        targetSessionKey: "agent:qwen:slack:channel:c1",
        userId: "U123",
      }),
    ).toEqual({
      commandTargetSessionKey: "agent:qwen:slack:channel:c1",
      sessionKey: "agent:qwen:slack:slash:u123",
    });
  });
});
