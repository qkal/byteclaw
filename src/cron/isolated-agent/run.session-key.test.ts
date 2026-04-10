import { describe, expect, it } from "vitest";
import { resolveCronAgentSessionKey } from "./session-key.js";

describe("resolveCronAgentSessionKey", () => {
  it("builds an agent-scoped key for legacy aliases", () => {
    expect(resolveCronAgentSessionKey({ agentId: "main", sessionKey: "main" })).toBe(
      "agent:main:main",
    );
  });

  it("preserves canonical agent keys instead of prefixing twice", () => {
    expect(resolveCronAgentSessionKey({ agentId: "main", sessionKey: "agent:main:main" })).toBe(
      "agent:main:main",
    );
  });

  it("normalizes canonical keys to lowercase before reuse", () => {
    expect(
      resolveCronAgentSessionKey({ agentId: "x", sessionKey: "AGENT:Main:Hook:Webhook:42" }),
    ).toBe("agent:main:hook:webhook:42");
  });

  it("keeps hook keys scoped under the target agent", () => {
    expect(resolveCronAgentSessionKey({ agentId: "main", sessionKey: "hook:webhook:42" })).toBe(
      "agent:main:hook:webhook:42",
    );
  });

  it("canonicalizes main alias when cfg.session.mainKey differs from default (#29683)", () => {
    const cfg = { session: { mainKey: "work" } };
    expect(
      resolveCronAgentSessionKey({ agentId: "ops", cfg, mainKey: "work", sessionKey: "main" }),
    ).toBe("agent:ops:work");
  });

  it("canonicalizes agent:id:main alias to configured mainKey (#29683)", () => {
    const cfg = { session: { mainKey: "work" } };
    expect(
      resolveCronAgentSessionKey({
        agentId: "ops",
        cfg,
        mainKey: "work",
        sessionKey: "agent:ops:main",
      }),
    ).toBe("agent:ops:work");
  });

  it("does not change non-alias keys when cfg is provided", () => {
    const cfg = { session: { mainKey: "work" } };
    expect(
      resolveCronAgentSessionKey({
        agentId: "ops",
        cfg,
        mainKey: "work",
        sessionKey: "hook:webhook:42",
      }),
    ).toBe("agent:ops:hook:webhook:42");
  });

  it("behaves unchanged when cfg is omitted (backward compat)", () => {
    expect(resolveCronAgentSessionKey({ agentId: "main", sessionKey: "main" })).toBe(
      "agent:main:main",
    );
  });
});
