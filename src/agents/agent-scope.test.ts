import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  hasConfiguredModelFallbacks,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentExplicitModelPrimary,
  resolveAgentIdByWorkspacePath,
  resolveAgentIdsByWorkspacePath,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
  resolveEffectiveModelFallbacks,
  resolveFallbackAgentId,
  resolveRunModelFallbacksOverride,
} from "./agent-scope.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: OpenClawConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            agentDir: "~/.openclaw/agents/main",
            id: "main",
            model: "anthropic/claude-sonnet-4-6",
            name: "Main Agent",
            workspace: "~/openclaw",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      agentDir: "~/.openclaw/agents/main",
      groupChat: undefined,
      identity: undefined,
      model: "anthropic/claude-sonnet-4-6",
      name: "Main Agent",
      sandbox: undefined,
      subagents: undefined,
      tools: undefined,
      workspace: "~/openclaw",
    });
  });

  it("prefers per-agent verbose defaults over global defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          verboseDefault: "full",
        },
        list: [
          {
            id: "main",
            verboseDefault: "on",
          },
        ],
      },
    };
    expect(resolveAgentConfig(cfg, "main")?.verboseDefault).toBe("on");
  });

  it("resolves explicit and effective model primary separately", () => {
    const cfgWithStringDefault = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
        },
        list: [{ id: "main" }],
      },
    } as unknown as OpenClawConfig;
    expect(resolveAgentExplicitModelPrimary(cfgWithStringDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithStringDefault, "main")).toBe(
      "anthropic/claude-sonnet-4-6",
    );

    const cfgWithObjectDefault: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            primary: "openai/gpt-5.4",
          },
        },
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgWithObjectDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithObjectDefault, "main")).toBe("openai/gpt-5.4");

    const cfgNoDefaults: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
  });

  it("supports per-agent model primary+fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            primary: "openai/gpt-5.4",
          },
        },
        list: [
          {
            id: "linus",
            model: {
              fallbacks: ["openai/gpt-5.4"],
              primary: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      },
    };

    expect(resolveAgentModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentExplicitModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentEffectiveModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentModelFallbacksOverride(cfg, "linus")).toEqual(["openai/gpt-5.4"]);

    // If fallbacks isn't present, we don't override the global fallbacks.
    const cfgNoOverride: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgNoOverride, "linus")).toBe(undefined);

    // Explicit empty list disables global fallbacks for that agent.
    const cfgDisable: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              fallbacks: [],
              primary: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgDisable, "linus")).toEqual([]);

    expect(
      resolveEffectiveModelFallbacks({
        agentId: "linus",
        cfg,
        hasSessionModelOverride: false,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        agentId: "linus",
        cfg,
        hasSessionModelOverride: true,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        agentId: "linus",
        cfg: cfgNoOverride,
        hasSessionModelOverride: true,
      }),
    ).toEqual([]);

    const cfgInheritDefaults: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      },
    };
    expect(
      resolveEffectiveModelFallbacks({
        agentId: "linus",
        cfg: cfgInheritDefaults,
        hasSessionModelOverride: true,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        agentId: "linus",
        cfg: cfgDisable,
        hasSessionModelOverride: true,
      }),
    ).toEqual([]);
  });

  it("resolves fallback agent id from explicit agent id first", () => {
    expect(
      resolveFallbackAgentId({
        agentId: "Support",
        sessionKey: "agent:main:session",
      }),
    ).toBe("support");
  });

  it("resolves fallback agent id from session key when explicit id is missing", () => {
    expect(
      resolveFallbackAgentId({
        sessionKey: "agent:worker:session",
      }),
    ).toBe("worker");
  });

  it("resolves run fallback overrides via shared helper", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "support",
            model: {
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };

    expect(
      resolveRunModelFallbacksOverride({
        agentId: "support",
        cfg,
        sessionKey: "agent:main:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveRunModelFallbacksOverride({
        agentId: undefined,
        cfg,
        sessionKey: "agent:support:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
  });

  it("computes whether any model fallbacks are configured via shared helper", () => {
    const cfgDefaultsOnly: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [{ id: "main" }],
      },
    };
    expect(
      hasConfiguredModelFallbacks({
        cfg: cfgDefaultsOnly,
        sessionKey: "agent:main:session",
      }),
    ).toBe(true);

    const cfgAgentOverrideOnly: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: [],
          },
        },
        list: [
          {
            id: "support",
            model: {
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };
    expect(
      hasConfiguredModelFallbacks({
        agentId: "support",
        cfg: cfgAgentOverrideOnly,
        sessionKey: "agent:support:session",
      }),
    ).toBe(true);
    expect(
      hasConfiguredModelFallbacks({
        agentId: "main",
        cfg: cfgAgentOverrideOnly,
        sessionKey: "agent:main:session",
      }),
    ).toBe(false);
  });

  it("should return agent-specific sandbox config", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "work",
            sandbox: {
              mode: "all",
              perSession: false,
              scope: "agent",
              workspaceAccess: "ro",
              workspaceRoot: "~/sandboxes",
            },
            workspace: "~/openclaw-work",
          },
        ],
      },
    } as unknown as OpenClawConfig;
    const result = resolveAgentConfig(cfg, "work");
    expect(result?.sandbox).toEqual({
      mode: "all",
      perSession: false,
      scope: "agent",
      workspaceAccess: "ro",
      workspaceRoot: "~/sandboxes",
    });
  });

  it("should return agent-specific tools config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "restricted",
            tools: {
              allow: ["read"],
              deny: ["exec", "write", "edit"],
              elevated: {
                allowFrom: { whatsapp: ["+15555550123"] },
                enabled: false,
              },
            },
            workspace: "~/openclaw-restricted",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "restricted");
    expect(result?.tools).toEqual({
      allow: ["read"],
      deny: ["exec", "write", "edit"],
      elevated: {
        allowFrom: { whatsapp: ["+15555550123"] },
        enabled: false,
      },
    });
  });

  it("should return both sandbox and tools config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: ["read"],
              deny: ["exec"],
            },
            workspace: "~/openclaw-family",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "family");
    expect(result?.sandbox?.mode).toBe("all");
    expect(result?.tools?.allow).toEqual(["read"]);
  });

  it("should normalize agent id", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    // Should normalize to "main" (default)
    const result = resolveAgentConfig(cfg, "");
    expect(result).toBeDefined();
    expect(result?.workspace).toBe("~/openclaw");
  });

  it("uses OPENCLAW_HOME for default agent workspace", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);

    const workspace = resolveAgentWorkspaceDir({} as OpenClawConfig, "main");
    expect(workspace).toBe(path.join(path.resolve(home), ".openclaw", "workspace"));
  });

  it("uses OPENCLAW_HOME for default agentDir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    // Clear state dir so it falls back to OPENCLAW_HOME
    vi.stubEnv("OPENCLAW_STATE_DIR", "");

    const agentDir = resolveAgentDir({} as OpenClawConfig, "main");
    expect(agentDir).toBe(path.join(path.resolve(home), ".openclaw", "agents", "main", "agent"));
  });

  it("non-default agent uses agents.defaults.workspace as base (#59789)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { default: true, id: "work", workspace: "/work-ws" }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "main");
    expect(workspace).toBe(path.resolve("/shared-ws/main"));
  });

  it("default agent without per-agent workspace uses agents.defaults.workspace directly", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { default: true, id: "work" }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "work");
    expect(workspace).toBe(path.resolve("/shared-ws"));
  });

  it("non-default agent without defaults.workspace falls back to stateDir", () => {
    const stateDir = path.join(path.sep, "tmp", "test-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }, { default: true, id: "work", workspace: "/work-ws" }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "main");
    expect(workspace).toBe(path.join(stateDir, "workspace-main"));
  });
});

describe("resolveAgentIdByWorkspacePath", () => {
  it("returns the most specific workspace match for a directory", () => {
    const workspaceRoot = `/tmp/openclaw-agent-scope-${Date.now()}-root`;
    const opsWorkspace = `${workspaceRoot}/projects/ops`;
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: opsWorkspace },
        ],
      },
    };

    expect(resolveAgentIdByWorkspacePath(cfg, `${opsWorkspace}/src`)).toBe("ops");
  });

  it("returns undefined when directory has no matching workspace", () => {
    const workspaceRoot = `/tmp/openclaw-agent-scope-${Date.now()}-root`;
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: `${workspaceRoot}-ops` },
        ],
      },
    };

    expect(
      resolveAgentIdByWorkspacePath(cfg, `/tmp/openclaw-agent-scope-${Date.now()}-unrelated`),
    ).toBeUndefined();
  });

  it("matches workspace paths through symlink aliases", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-scope-"));
    const realWorkspaceRoot = path.join(tempRoot, "real-root");
    const realOpsWorkspace = path.join(realWorkspaceRoot, "projects", "ops");
    const aliasWorkspaceRoot = path.join(tempRoot, "alias-root");
    try {
      fs.mkdirSync(path.join(realOpsWorkspace, "src"), { recursive: true });
      fs.symlinkSync(
        realWorkspaceRoot,
        aliasWorkspaceRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: realWorkspaceRoot },
            { id: "ops", workspace: realOpsWorkspace },
          ],
        },
      };

      expect(
        resolveAgentIdByWorkspacePath(cfg, path.join(aliasWorkspaceRoot, "projects", "ops")),
      ).toBe("ops");
      expect(
        resolveAgentIdByWorkspacePath(cfg, path.join(aliasWorkspaceRoot, "projects", "ops", "src")),
      ).toBe("ops");
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("resolveAgentIdsByWorkspacePath", () => {
  it("returns matching workspaces ordered by specificity", () => {
    const workspaceRoot = `/tmp/openclaw-agent-scope-${Date.now()}-root`;
    const opsWorkspace = `${workspaceRoot}/projects/ops`;
    const opsDevWorkspace = `${opsWorkspace}/dev`;
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: opsWorkspace },
          { id: "ops-dev", workspace: opsDevWorkspace },
        ],
      },
    };

    expect(resolveAgentIdsByWorkspacePath(cfg, `${opsDevWorkspace}/pkg`)).toEqual([
      "ops-dev",
      "ops",
      "main",
    ]);
  });
});

describe("resolveAgentSkillsFilter", () => {
  it("inherits agents.defaults.skills when the agent omits skills", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer" }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["github", "weather"]);
  });

  it("uses agents.list[].skills as a full replacement", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: ["docs-search"] }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["docs-search"]);
  });

  it("keeps explicit empty agent skills as no skills", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: [] }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual([]);
  });
});
