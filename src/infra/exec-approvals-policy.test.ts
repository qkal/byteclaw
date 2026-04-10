import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  collectExecPolicyScopeSnapshots,
  resolveExecPolicyScopeSummary,
} from "./exec-approvals-effective.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import {
  type ExecApprovalsFile,
  evaluateExecAllowlist,
  hasDurableExecApproval,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecSecurity,
  normalizeExecTarget,
  requiresExecApproval,
} from "./exec-approvals.js";

describe("exec approvals policy helpers", () => {
  it.each([
    { expected: "gateway", raw: " gateway " },
    { expected: "node", raw: "NODE" },
    { expected: null, raw: "" },
    { expected: null, raw: "ssh" },
  ])("normalizes exec host value %j", ({ raw, expected }) => {
    expect(normalizeExecHost(raw)).toBe(expected);
  });

  it.each([
    { expected: "auto", raw: " auto " },
    { expected: "gateway", raw: " gateway " },
    { expected: "node", raw: "NODE" },
    { expected: null, raw: "" },
    { expected: null, raw: "ssh" },
  ])("normalizes exec target value %j", ({ raw, expected }) => {
    expect(normalizeExecTarget(raw)).toBe(expected);
  });

  it.each([
    { expected: "allowlist", raw: " allowlist " },
    { expected: "full", raw: "FULL" },
    { expected: null, raw: "unknown" },
  ])("normalizes exec security value %j", ({ raw, expected }) => {
    expect(normalizeExecSecurity(raw)).toBe(expected);
  });

  it.each([
    { expected: "on-miss", raw: " on-miss " },
    { expected: "always", raw: "ALWAYS" },
    { expected: null, raw: "maybe" },
  ])("normalizes exec ask value %j", ({ raw, expected }) => {
    expect(normalizeExecAsk(raw)).toBe(expected);
  });

  it.each([
    { expected: "deny" as const, left: "deny" as const, right: "full" as const },
    {
      expected: "allowlist" as const,
      left: "allowlist" as const,
      right: "full" as const,
    },
    {
      expected: "allowlist" as const,
      left: "full" as const,
      right: "allowlist" as const,
    },
  ])("minSecurity picks the more restrictive value for %j", ({ left, right, expected }) => {
    expect(minSecurity(left, right)).toBe(expected);
  });

  it.each([
    { expected: "always" as const, left: "off" as const, right: "always" as const },
    { expected: "on-miss" as const, left: "on-miss" as const, right: "off" as const },
    { expected: "always" as const, left: "always" as const, right: "on-miss" as const },
  ])("maxAsk picks the more aggressive ask mode for %j", ({ left, right, expected }) => {
    expect(maxAsk(left, right)).toBe(expected);
  });

  it.each([
    {
      allowlistSatisfied: true,
      analysisOk: true,
      ask: "always" as const,
      expected: true,
      security: "allowlist" as const,
    },
    {
      allowlistSatisfied: false,
      analysisOk: true,
      ask: "always" as const,
      durableApprovalSatisfied: true,
      expected: true,
      security: "full" as const,
    },
    {
      allowlistSatisfied: false,
      analysisOk: true,
      ask: "off" as const,
      expected: false,
      security: "allowlist" as const,
    },
    {
      allowlistSatisfied: true,
      analysisOk: true,
      ask: "on-miss" as const,
      expected: false,
      security: "allowlist" as const,
    },
    {
      allowlistSatisfied: false,
      analysisOk: false,
      ask: "on-miss" as const,
      expected: true,
      security: "allowlist" as const,
    },
    {
      allowlistSatisfied: false,
      analysisOk: false,
      ask: "on-miss" as const,
      expected: false,
      security: "full" as const,
    },
  ])("requiresExecApproval respects ask mode and allowlist satisfaction for %j", (testCase) => {
    expect(requiresExecApproval(testCase)).toBe(testCase.expected);
  });

  it("treats exact-command allow-always approvals as durable trust", () => {
    expect(
      hasDurableExecApproval({
        allowlist: [
          {
            pattern: "=command:613b5a60181648fd",
            source: "allow-always",
          },
        ],
        analysisOk: false,
        commandText: 'powershell -NoProfile -Command "Write-Output hi"',
        segmentAllowlistEntries: [],
      }),
    ).toBe(true);
  });

  it("treats fully allow-always-matched segments as durable trust", () => {
    expect(
      hasDurableExecApproval({
        allowlist: [],
        analysisOk: true,
        segmentAllowlistEntries: [
          { pattern: "/usr/bin/echo", source: "allow-always" },
          { pattern: "/usr/bin/printf", source: "allow-always" },
        ],
      }),
    ).toBe(true);
  });

  it("marks policy-blocked segments as non-durable allowlist entries", () => {
    const executable = makeMockExecutableResolution({
      executableName: "echo",
      rawExecutable: "/usr/bin/echo",
      resolvedPath: "/usr/bin/echo",
    });
    const result = evaluateExecAllowlist({
      allowlist: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      analysis: {
        ok: true,
        segments: [
          {
            argv: ["/usr/bin/echo", "ok"],
            raw: "/usr/bin/echo ok",
            resolution: makeMockCommandResolution({
              execution: executable,
            }),
          },
          {
            argv: ["/bin/sh", "-lc", "whoami"],
            raw: "/bin/sh -lc whoami",
            resolution: makeMockCommandResolution({
              execution: makeMockExecutableResolution({
                rawExecutable: "/bin/sh",
                resolvedPath: "/bin/sh",
                executableName: "sh",
              }),
              policyBlocked: true,
            }),
          },
        ],
      },
      cwd: "/tmp",
      platform: process.platform,
      safeBins: new Set(),
    });

    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentAllowlistEntries).toEqual([
      expect.objectContaining({ pattern: "/usr/bin/echo" }),
      null,
    ]);
    expect(
      hasDurableExecApproval({
        allowlist: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
        analysisOk: true,
        segmentAllowlistEntries: result.segmentAllowlistEntries,
      }),
    ).toBe(false);
  });

  it("explains stricter host security and ask precedence", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        defaults: {
          ask: "always",
          askFallback: "deny",
          security: "allowlist",
        },
        version: 1,
      },
      configPath: "tools.exec",
      scopeExecConfig: {
        ask: "off",
        security: "full",
      },
      scopeLabel: "tools.exec",
    });

    expect(summary.security).toMatchObject({
      effective: "allowlist",
      host: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json defaults.security",
      note: "stricter host security wins",
      requested: "full",
    });
    expect(summary.ask).toMatchObject({
      effective: "always",
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json defaults.ask",
      note: "more aggressive ask wins",
      requested: "off",
    });
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "~/.openclaw/exec-approvals.json defaults.askFallback",
    });
  });

  it("uses the actual approvals path when reporting host sources", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        defaults: {
          ask: "always",
          askFallback: "deny",
          security: "allowlist",
        },
        version: 1,
      },
      configPath: "tools.exec",
      hostPath: "/tmp/node-exec-approvals.json",
      scopeExecConfig: {
        ask: "off",
        security: "full",
      },
      scopeLabel: "tools.exec",
    });

    expect(summary.security.hostSource).toBe("/tmp/node-exec-approvals.json defaults.security");
    expect(summary.ask.hostSource).toBe("/tmp/node-exec-approvals.json defaults.ask");
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "/tmp/node-exec-approvals.json defaults.askFallback",
    });
  });

  it("does not let host ask=off suppress a stricter requested ask", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        defaults: {
          ask: "off",
        },
        version: 1,
      },
      configPath: "tools.exec",
      scopeExecConfig: {
        ask: "always",
      },
      scopeLabel: "tools.exec",
    });

    expect(summary.ask).toMatchObject({
      effective: "always",
      host: "off",
      note: "requested ask applies",
      requested: "always",
    });
  });

  it("clamps askFallback to the effective security", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        defaults: {
          ask: "always",
          askFallback: "full",
          security: "full",
        },
        version: 1,
      },
      configPath: "tools.exec",
      scopeExecConfig: {
        ask: "always",
        security: "allowlist",
      },
      scopeLabel: "tools.exec",
    });

    expect(summary.askFallback).toEqual({
      effective: "allowlist",
      source: "~/.openclaw/exec-approvals.json defaults.askFallback",
    });
  });

  it("skips malformed host fields when attributing their source", () => {
    const approvals = {
      agents: {
        runner: {
          ask: "foo",
        },
      },
      defaults: {
        ask: "always",
      },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const summary = resolveExecPolicyScopeSummary({
      agentId: "runner",
      approvals,
      configPath: "agents.list.runner.tools.exec",
      globalExecConfig: {
        ask: "off",
      },
      scopeLabel: "agent:runner",
    });

    expect(summary.ask).toMatchObject({
      effective: "always",
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json defaults.ask",
      note: "more aggressive ask wins",
      requested: "off",
    });
  });

  it("ignores malformed non-string host fields when attributing their source", () => {
    const approvals = {
      agents: {
        runner: {
          ask: true,
        },
      },
      defaults: {
        ask: "always",
      },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const summary = resolveExecPolicyScopeSummary({
      agentId: "runner",
      approvals,
      configPath: "agents.list.runner.tools.exec",
      globalExecConfig: {
        ask: "off",
      },
      scopeLabel: "agent:runner",
    });

    expect(summary.ask).toMatchObject({
      effective: "always",
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json defaults.ask",
      note: "more aggressive ask wins",
      requested: "off",
    });
  });

  it("does not credit mixed-case host fields that resolution ignores", () => {
    const approvals = {
      agents: {
        runner: {
          ask: "Always",
        },
      },
      defaults: {
        ask: "always",
      },
      version: 1,
    } as unknown as ExecApprovalsFile;
    const summary = resolveExecPolicyScopeSummary({
      agentId: "runner",
      approvals,
      configPath: "agents.list.runner.tools.exec",
      globalExecConfig: {
        ask: "off",
      },
      scopeLabel: "agent:runner",
    });

    expect(summary.ask).toMatchObject({
      effective: "always",
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json defaults.ask",
      note: "more aggressive ask wins",
      requested: "off",
    });
  });

  it("attributes host policy to wildcard agent entries before defaults", () => {
    const summary = resolveExecPolicyScopeSummary({
      agentId: "runner",
      approvals: {
        agents: {
          "*": {
            ask: "always",
            askFallback: "deny",
            security: "allowlist",
          },
        },
        defaults: {
          ask: "off",
          askFallback: "full",
          security: "full",
        },
        version: 1,
      },
      configPath: "agents.list.runner.tools.exec",
      scopeExecConfig: {
        ask: "off",
        security: "full",
      },
      scopeLabel: "agent:runner",
    });

    expect(summary.security).toMatchObject({
      host: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json agents.*.security",
    });
    expect(summary.ask).toMatchObject({
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json agents.*.ask",
    });
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "~/.openclaw/exec-approvals.json agents.*.askFallback",
    });
  });

  it("inherits requested agent policy from global tools.exec config", () => {
    const summary = resolveExecPolicyScopeSummary({
      agentId: "runner",
      approvals: {
        agents: {
          runner: {
            ask: "always",
            security: "allowlist",
          },
        },
        version: 1,
      },
      configPath: "agents.list.runner.tools.exec",
      globalExecConfig: {
        ask: "off",
        security: "full",
      },
      scopeLabel: "agent:runner",
    });

    expect(summary.security).toMatchObject({
      effective: "allowlist",
      host: "allowlist",
      requested: "full",
      requestedSource: "tools.exec.security",
    });
    expect(summary.ask).toMatchObject({
      effective: "always",
      host: "always",
      requested: "off",
      requestedSource: "tools.exec.ask",
    });
  });

  it("reports askFallback from the OpenClaw default when approvals omit it", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        agents: {},
        version: 1,
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.askFallback).toEqual({
      effective: "full",
      source: "OpenClaw default (full)",
    });
  });

  it("collects global, configured-agent, and approvals-only agent scopes", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      approvals: {
        agents: {
          batch: {
            ask: "always",
          },
          runner: {
            security: "allowlist",
          },
        },
        version: 1,
      },
      cfg: {
        agents: {
          list: [{ id: "runner" }],
        },
        tools: {
          exec: {
            ask: "off",
            security: "full",
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual([
      "tools.exec",
      "agent:batch",
      "agent:runner",
    ]);
    expect(snapshots[1]?.ask).toMatchObject({
      effective: "always",
      host: "always",
      requested: "off",
      requestedSource: "tools.exec.ask",
    });
    expect(snapshots[2]?.security).toMatchObject({
      effective: "allowlist",
      host: "allowlist",
      requested: "full",
      requestedSource: "tools.exec.security",
    });
  });

  it("avoids a duplicate default-agent scope when main only appears in approvals", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      approvals: {
        agents: {
          [DEFAULT_AGENT_ID]: {
            ask: "always",
            security: "allowlist",
          },
        },
        version: 1,
      },
      cfg: {
        tools: {
          exec: {
            ask: "off",
            security: "full",
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual(["tools.exec"]);
    expect(snapshots[0]?.security).toMatchObject({
      host: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json agents.main.security",
    });
    expect(snapshots[0]?.ask).toMatchObject({
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json agents.main.ask",
    });
  });

  it("keeps the default agent scope when main has an explicit exec override", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      approvals: {
        version: 1,
      },
      cfg: {
        agents: {
          list: [
            {
              id: DEFAULT_AGENT_ID,
              tools: {
                exec: {
                  ask: "always",
                },
              },
            },
          ],
        },
        tools: {
          exec: {
            ask: "off",
            security: "full",
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual(["tools.exec", "agent:main"]);
    expect(snapshots[1]?.ask).toMatchObject({
      requested: "always",
      requestedSource: "agents.list.main.tools.exec.ask",
    });
  });
});
