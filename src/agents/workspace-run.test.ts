import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveRunWorkspaceDir } from "./workspace-run.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

describe("resolveRunWorkspaceDir", () => {
  it("resolves explicit workspace values without fallback", () => {
    const explicit = path.join(process.cwd(), "tmp", "workspace-run-explicit");
    const result = resolveRunWorkspaceDir({
      sessionKey: "agent:main:subagent:test",
      workspaceDir: explicit,
    });

    expect(result.usedFallback).toBe(false);
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(explicit));
  });

  it("falls back to configured per-agent workspace when input is missing", () => {
    const defaultWorkspace = path.join(process.cwd(), "tmp", "workspace-default-main");
    const researchWorkspace = path.join(process.cwd(), "tmp", "workspace-research");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        list: [{ id: "research", workspace: researchWorkspace }],
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      config: cfg,
      sessionKey: "agent:research:subagent:test",
      workspaceDir: undefined,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe("missing");
    expect(result.agentId).toBe("research");
    expect(result.workspaceDir).toBe(path.resolve(researchWorkspace));
  });

  it("falls back to default workspace for blank strings", () => {
    const defaultWorkspace = path.join(process.cwd(), "tmp", "workspace-default-main");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      config: cfg,
      sessionKey: "agent:main:subagent:test",
      workspaceDir: "   ",
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe("blank");
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(defaultWorkspace));
  });

  it("falls back to built-in main workspace when config is unavailable", () => {
    const result = resolveRunWorkspaceDir({
      config: undefined,
      sessionKey: "agent:main:subagent:test",
      workspaceDir: null,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe("missing");
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(resolveDefaultAgentWorkspaceDir(process.env)));
  });

  it("throws for malformed agent session keys", () => {
    expect(() =>
      resolveRunWorkspaceDir({
        config: undefined,
        sessionKey: "agent::broken",
        workspaceDir: undefined,
      }),
    ).toThrow("Malformed agent session key");
  });

  it("uses explicit agent id for per-agent fallback when config is unavailable", () => {
    const result = resolveRunWorkspaceDir({
      agentId: "research",
      config: undefined,
      sessionKey: "definitely-not-a-valid-session-key",
      workspaceDir: undefined,
    });

    expect(result.agentId).toBe("research");
    expect(result.agentIdSource).toBe("explicit");
    expect(result.workspaceDir).toBe(
      path.resolve(resolveStateDir(process.env), "workspace-research"),
    );
  });

  it("throws for malformed agent session keys even when config has a default agent", () => {
    const mainWorkspace = path.join(process.cwd(), "tmp", "workspace-main-default");
    const researchWorkspace = path.join(process.cwd(), "tmp", "workspace-research-default");
    const cfg = {
      agents: {
        defaults: { workspace: mainWorkspace },
        list: [
          { id: "main", workspace: mainWorkspace },
          { default: true, id: "research", workspace: researchWorkspace },
        ],
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveRunWorkspaceDir({
        config: cfg,
        sessionKey: "agent::broken",
        workspaceDir: undefined,
      }),
    ).toThrow("Malformed agent session key");
  });

  it("treats non-agent legacy keys as default, not malformed", () => {
    const fallbackWorkspace = path.join(process.cwd(), "tmp", "workspace-default-legacy");
    const cfg = {
      agents: {
        defaults: { workspace: fallbackWorkspace },
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      config: cfg,
      sessionKey: "custom-main-key",
      workspaceDir: undefined,
    });

    expect(result.agentId).toBe("main");
    expect(result.agentIdSource).toBe("default");
    expect(result.workspaceDir).toBe(path.resolve(fallbackWorkspace));
  });
});
