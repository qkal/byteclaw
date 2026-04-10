import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentBindings,
  applyAgentConfig,
  buildAgentSummaries,
  pruneAgentConfig,
  removeAgentBindings,
} from "./agents.js";

describe("agents helpers", () => {
  it("buildAgentSummaries includes default + configured agents", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude" },
          workspace: "/main-ws",
        },
        list: [
          { id: "main" },
          {
            agentDir: "/state/agents/work/agent",
            default: true,
            id: "work",
            model: "openai/gpt-4.1",
            name: "Work",
            workspace: "/work-ws",
          },
        ],
      },
      bindings: [
        {
          agentId: "work",
          match: { accountId: "biz", channel: "whatsapp" },
        },
        { agentId: "main", match: { channel: "telegram" } },
      ],
    };

    const summaries = buildAgentSummaries(cfg);
    const main = summaries.find((summary) => summary.id === "main");
    const work = summaries.find((summary) => summary.id === "work");

    expect(main).toBeTruthy();
    expect(main?.workspace).toBe(path.resolve("/main-ws/main"));
    expect(main?.bindings).toBe(1);
    expect(main?.model).toBe("anthropic/claude");
    expect(main?.agentDir.endsWith(path.join("agents", "main", "agent"))).toBe(true);

    expect(work).toBeTruthy();
    expect(work?.name).toBe("Work");
    expect(work?.workspace).toBe(path.resolve("/work-ws"));
    expect(work?.agentDir).toBe(path.resolve("/state/agents/work/agent"));
    expect(work?.bindings).toBe(1);
    expect(work?.isDefault).toBe(true);
  });

  it("applyAgentConfig merges updates", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "work", model: "anthropic/claude", workspace: "/old-ws" }],
      },
    };

    const next = applyAgentConfig(cfg, {
      agentDir: "/state/work/agent",
      agentId: "work",
      name: "Work",
      workspace: "/new-ws",
    });

    const work = next.agents?.list?.find((agent) => agent.id === "work");
    expect(work?.name).toBe("Work");
    expect(work?.workspace).toBe("/new-ws");
    expect(work?.agentDir).toBe("/state/work/agent");
    expect(work?.model).toBe("anthropic/claude");
  });

  it("applyAgentConfig merges identity with existing", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "work", identity: { emoji: "🐢", name: "Old", theme: "chill" } }],
      },
    };

    const next = applyAgentConfig(cfg, {
      agentId: "work",
      identity: { emoji: "🦀", name: "New" },
    });

    const work = next.agents?.list?.find((agent) => agent.id === "work");
    expect(work?.identity?.name).toBe("New");
    expect(work?.identity?.emoji).toBe("🦀");
    expect(work?.identity?.theme).toBe("chill");
  });

  it("applyAgentConfig skips identity when not provided", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "work", identity: { emoji: "🐢", name: "Keep" } }],
      },
    };

    const next = applyAgentConfig(cfg, { agentId: "work", name: "Renamed" });

    const work = next.agents?.list?.find((agent) => agent.id === "work");
    expect(work?.name).toBe("Renamed");
    expect(work?.identity?.name).toBe("Keep");
    expect(work?.identity?.emoji).toBe("🐢");
  });

  it("applyAgentBindings skips duplicates and reports conflicts", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: { accountId: "default", channel: "whatsapp" },
        },
      ],
    };

    const result = applyAgentBindings(cfg, [
      {
        agentId: "main",
        match: { accountId: "default", channel: "whatsapp" },
      },
      {
        agentId: "work",
        match: { accountId: "default", channel: "whatsapp" },
      },
      {
        agentId: "work",
        match: { channel: "telegram" },
      },
    ]);

    expect(result.added).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.config.bindings).toHaveLength(2);
  });

  it("applyAgentBindings upgrades channel-only binding to account-specific binding for same agent", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: { channel: "telegram" },
        },
      ],
    };

    const result = applyAgentBindings(cfg, [
      {
        agentId: "main",
        match: { accountId: "work", channel: "telegram" },
      },
    ]);

    expect(result.added).toHaveLength(0);
    expect(result.updated).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.config.bindings).toEqual([
      {
        agentId: "main",
        match: { accountId: "work", channel: "telegram" },
      },
    ]);
  });

  it("applyAgentBindings treats role-based bindings as distinct routes", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: {
            accountId: "guild-a",
            channel: "discord",
            guildId: "123",
            roles: ["111", "222"],
          },
        },
      ],
    };

    const result = applyAgentBindings(cfg, [
      {
        agentId: "work",
        match: {
          accountId: "guild-a",
          channel: "discord",
          guildId: "123",
        },
      },
    ]);

    expect(result.added).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.config.bindings).toHaveLength(2);
  });

  it("removeAgentBindings does not remove role-based bindings when removing channel-level routes", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: {
            accountId: "guild-a",
            channel: "discord",
            guildId: "123",
            roles: ["111", "222"],
          },
        },
        {
          agentId: "main",
          match: {
            accountId: "guild-a",
            channel: "discord",
            guildId: "123",
          },
        },
      ],
    };

    const result = removeAgentBindings(cfg, [
      {
        agentId: "main",
        match: {
          accountId: "guild-a",
          channel: "discord",
          guildId: "123",
        },
      },
    ]);

    expect(result.removed).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.config.bindings).toEqual([
      {
        agentId: "main",
        match: {
          accountId: "guild-a",
          channel: "discord",
          guildId: "123",
          roles: ["111", "222"],
        },
      },
    ]);
  });

  it("pruneAgentConfig removes agent, bindings, and allowlist entries", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { default: true, id: "work", workspace: "/work-ws" },
          { id: "home", workspace: "/home-ws" },
        ],
      },
      bindings: [
        { agentId: "work", match: { channel: "whatsapp" } },
        { agentId: "home", match: { channel: "telegram" } },
      ],
      tools: {
        agentToAgent: { allow: ["work", "home"], enabled: true },
      },
    };

    const result = pruneAgentConfig(cfg, "work");
    expect(result.config.agents?.list?.some((agent) => agent.id === "work")).toBe(false);
    expect(result.config.agents?.list?.some((agent) => agent.id === "home")).toBe(true);
    expect(result.config.bindings).toHaveLength(1);
    expect(result.config.bindings?.[0]?.agentId).toBe("home");
    expect(result.config.tools?.agentToAgent?.allow).toEqual(["home"]);
    expect(result.removedBindings).toBe(1);
    expect(result.removedAllow).toBe(1);
  });
});
