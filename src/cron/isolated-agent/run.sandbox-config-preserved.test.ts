import { describe, expect, it } from "vitest";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";

function makeCfg() {
  return {
    agents: {
      defaults: {
        sandbox: {
          browser: {
            autoStart: false,
            enabled: true,
          },
          docker: {
            dangerouslyAllowContainerNamespaceJoin: true,
            dangerouslyAllowExternalBindSources: true,
            network: "none",
          },
          mode: "all" as const,
          prune: {
            maxAgeDays: 7,
          },
          workspaceAccess: "rw" as const,
        },
      },
    },
  };
}

function buildRunCfg(agentId: string, agentConfigOverride?: Record<string, unknown>) {
  const cfg = makeCfg();
  const agentDefaults = buildCronAgentDefaultsConfig({
    agentConfigOverride: agentConfigOverride as never,
    defaults: cfg.agents.defaults,
  });
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: agentDefaults,
      list: [{ id: agentId, ...agentConfigOverride }],
    },
  };
}

function expectDefaultSandboxPreserved(
  runCfg:
    | {
        agents?: { defaults?: { sandbox?: unknown } };
      }
    | undefined,
) {
  expect(runCfg?.agents?.defaults?.sandbox).toEqual({
    browser: {
      autoStart: false,
      enabled: true,
    },
    docker: {
      dangerouslyAllowContainerNamespaceJoin: true,
      dangerouslyAllowExternalBindSources: true,
      network: "none",
    },
    mode: "all",
    prune: {
      maxAgeDays: 7,
    },
    workspaceAccess: "rw",
  });
}

describe("runCronIsolatedAgentTurn sandbox config preserved", () => {
  it("preserves default sandbox config when agent entry omits sandbox", async () => {
    const runCfg = buildRunCfg("worker", {
      heartbeat: undefined,
      name: "worker",
      sandbox: undefined,
      tools: undefined,
      workspace: "/tmp/custom-workspace",
    });
    expectDefaultSandboxPreserved(runCfg);
    expect(resolveSandboxConfigForAgent(runCfg, "worker")).toMatchObject({
      mode: "all",
      workspaceAccess: "rw",
    });
  });

  it("keeps global sandbox defaults when agent override is partial", async () => {
    const runCfg = buildRunCfg("specialist", {
      sandbox: {
        browser: {
          image: "ghcr.io/openclaw/browser:custom",
        },
        docker: {
          image: "ghcr.io/openclaw/sandbox:custom",
        },
        prune: {
          idleHours: 1,
        },
      },
    });
    const resolvedSandbox = resolveSandboxConfigForAgent(runCfg, "specialist");

    expectDefaultSandboxPreserved(runCfg);
    expect(resolvedSandbox.mode).toBe("all");
    expect(resolvedSandbox.workspaceAccess).toBe("rw");
    expect(resolvedSandbox.docker).toMatchObject({
      dangerouslyAllowContainerNamespaceJoin: true,
      dangerouslyAllowExternalBindSources: true,
      image: "ghcr.io/openclaw/sandbox:custom",
      network: "none",
    });
    expect(resolvedSandbox.browser).toMatchObject({
      autoStart: false,
      enabled: true,
      image: "ghcr.io/openclaw/browser:custom",
    });
    expect(resolvedSandbox.prune).toMatchObject({
      idleHours: 1,
      maxAgeDays: 7,
    });
  });
});
