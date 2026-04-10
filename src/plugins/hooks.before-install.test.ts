import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { type PluginRegistry, createEmptyPluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookBeforeInstallResult,
  PluginHookRegistration,
} from "./types.js";

function addBeforeInstallHook(
  registry: PluginRegistry,
  pluginId: string,
  handler:
    | (() => PluginHookBeforeInstallResult | Promise<PluginHookBeforeInstallResult>)
    | PluginHookRegistration["handler"],
  priority?: number,
) {
  addTestHook({
    handler: handler as PluginHookRegistration["handler"],
    hookName: "before_install",
    pluginId,
    priority,
    registry,
  });
}

const stubCtx: PluginHookBeforeInstallContext = {
  origin: "openclaw-workspace",
  requestKind: "skill-install",
  targetType: "skill",
};

const stubEvent: PluginHookBeforeInstallEvent = {
  builtinScan: {
    critical: 0,
    findings: [],
    info: 0,
    scannedFiles: 1,
    status: "ok",
    warn: 0,
  },
  origin: "openclaw-workspace",
  request: {
    kind: "skill-install",
    mode: "install",
  },
  skill: {
    installId: "deps",
  },
  sourcePath: "/tmp/demo-skill",
  sourcePathKind: "directory",
  targetName: "demo-skill",
  targetType: "skill",
};

describe("before_install hook merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("accumulates findings across handlers in priority order", async () => {
    addBeforeInstallHook(
      registry,
      "plugin-a",
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            file: "a.ts",
            line: 1,
            message: "first finding",
            ruleId: "first",
            severity: "warn",
          },
        ],
      }),
      100,
    );
    addBeforeInstallHook(
      registry,
      "plugin-b",
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            file: "b.ts",
            line: 2,
            message: "second finding",
            ruleId: "second",
            severity: "critical",
          },
        ],
      }),
      50,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeInstall(stubEvent, stubCtx);

    expect(result).toEqual({
      block: undefined,
      blockReason: undefined,
      findings: [
        {
          file: "a.ts",
          line: 1,
          message: "first finding",
          ruleId: "first",
          severity: "warn",
        },
        {
          file: "b.ts",
          line: 2,
          message: "second finding",
          ruleId: "second",
          severity: "critical",
        },
      ],
    });
  });

  it("short-circuits after block=true and preserves earlier findings", async () => {
    const blocker = vi.fn(
      (): PluginHookBeforeInstallResult => ({
        block: true,
        blockReason: "policy blocked",
        findings: [
          {
            file: "block.ts",
            line: 3,
            message: "blocked finding",
            ruleId: "blocker",
            severity: "critical",
          },
        ],
      }),
    );
    const skipped = vi.fn(
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            file: "skip.ts",
            line: 4,
            message: "should not appear",
            ruleId: "skipped",
            severity: "warn",
          },
        ],
      }),
    );

    addBeforeInstallHook(
      registry,
      "plugin-a",
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            file: "a.ts",
            line: 1,
            message: "first finding",
            ruleId: "first",
            severity: "warn",
          },
        ],
      }),
      100,
    );
    addBeforeInstallHook(registry, "plugin-block", blocker, 50);
    addBeforeInstallHook(registry, "plugin-skipped", skipped, 10);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeInstall(stubEvent, stubCtx);

    expect(result).toEqual({
      block: true,
      blockReason: "policy blocked",
      findings: [
        {
          file: "a.ts",
          line: 1,
          message: "first finding",
          ruleId: "first",
          severity: "warn",
        },
        {
          file: "block.ts",
          line: 3,
          message: "blocked finding",
          ruleId: "blocker",
          severity: "critical",
        },
      ],
    });
    expect(blocker).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });
});
