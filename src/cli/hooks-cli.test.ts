import { describe, expect, it } from "vitest";
import type { HookStatusReport } from "../hooks/hooks-status.js";
import { formatHookInfo, formatHooksCheck, formatHooksList } from "./hooks-cli.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";

const report: HookStatusReport = {
  hooks: [
    {
      always: false,
      baseDir: "/tmp/hooks/session-memory",
      blockedReason: undefined,
      description: "Save session context to memory",
      emoji: "💾",
      enabledByConfig: true,
      events: ["command:new"],
      filePath: "/tmp/hooks/session-memory/HOOK.md",
      handlerPath: "/tmp/hooks/session-memory/handler.js",
      homepage: "https://docs.openclaw.ai/automation/hooks#session-memory",
      hookKey: "session-memory",
      loadable: true,
      managedByPlugin: false,
      name: "session-memory",
      pluginId: undefined,
      requirementsSatisfied: true,
      source: "openclaw-bundled",
      ...createEmptyInstallChecks(),
    },
  ],
  managedHooksDir: "/tmp/hooks",
  workspaceDir: "/tmp/workspace",
};

function createPluginManagedHookReport(): HookStatusReport {
  return {
    hooks: [
      {
        always: false,
        baseDir: "/tmp/hooks/plugin-hook",
        blockedReason: undefined,
        description: "Hook from plugin",
        emoji: "🔗",
        enabledByConfig: true,
        events: ["command:new"],
        filePath: "/tmp/hooks/plugin-hook/HOOK.md",
        handlerPath: "/tmp/hooks/plugin-hook/handler.js",
        homepage: undefined,
        hookKey: "plugin-hook",
        loadable: true,
        managedByPlugin: true,
        name: "plugin-hook",
        pluginId: "voice-call",
        requirementsSatisfied: true,
        source: "openclaw-plugin",
        ...createEmptyInstallChecks(),
      },
    ],
    managedHooksDir: "/tmp/hooks",
    workspaceDir: "/tmp/workspace",
  };
}

describe("hooks cli formatting", () => {
  it("labels hooks list output", () => {
    const output = formatHooksList(report, {});
    expect(output).toContain("Hooks");
    expect(output).not.toContain("Internal Hooks");
  });

  it("labels hooks status output", () => {
    const output = formatHooksCheck(report, {});
    expect(output).toContain("Hooks Status");
  });

  it("labels plugin-managed hooks with plugin id", () => {
    const pluginReport = createPluginManagedHookReport();

    const output = formatHooksList(pluginReport, {});
    expect(output).toContain("plugin:voice-call");
  });

  it("shows plugin-managed details in hook info", () => {
    const pluginReport = createPluginManagedHookReport();

    const output = formatHookInfo(pluginReport, "plugin-hook", {});
    expect(output).toContain("voice-call");
    expect(output).toContain("Managed by plugin");
  });
});
