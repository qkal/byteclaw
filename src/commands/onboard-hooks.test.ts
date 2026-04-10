import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setupInternalHooks } from "./onboard-hooks.js";

// Mock hook discovery modules
vi.mock("../hooks/hooks-status.js", () => ({
  buildWorkspaceHookStatus: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/mock/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
}));

describe("onboard-hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockPrompter = (multiselectValue: string[]): WizardPrompter => ({
    confirm: vi.fn().mockResolvedValue(true),
    intro: vi.fn().mockResolvedValue(undefined),
    multiselect: vi.fn().mockResolvedValue(multiselectValue),
    note: vi.fn().mockResolvedValue(undefined),
    outro: vi.fn().mockResolvedValue(undefined),
    progress: vi.fn().mockReturnValue({
      stop: vi.fn(),
      update: vi.fn(),
    }),
    select: vi.fn().mockResolvedValue(""),
    text: vi.fn().mockResolvedValue(""),
  });

  const createMockRuntime = (): RuntimeEnv => ({
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  });

  const createMockHook = (
    params: {
      name: string;
      description: string;
      filePath: string;
      baseDir: string;
      handlerPath: string;
      hookKey: string;
      emoji: string;
      events: string[];
    },
    eligible: boolean,
  ) => ({
    blockedReason: (eligible
      ? undefined
      : "missing requirements") as HookStatusEntry["blockedReason"],
    ...params,
    source: "openclaw-bundled" as const,
    pluginId: undefined,
    homepage: undefined,
    always: false,
    enabledByConfig: eligible,
    requirementsSatisfied: eligible,
    loadable: eligible,
    managedByPlugin: false,
    requirements: {
      anyBins: [],
      bins: [],
      config: ["workspace.dir"],
      env: [],
      os: [],
    },
    missing: {
      anyBins: [],
      bins: [],
      config: eligible ? [] : ["workspace.dir"],
      env: [],
      os: [],
    },
    configChecks: [],
    install: [],
  });

  const createMockHookReport = (eligible = true): HookStatusReport => ({
    hooks: [
      createMockHook(
        {
          baseDir: "/mock/workspace/hooks/session-memory",
          description: "Save session context to memory when /new or /reset command is issued",
          emoji: "💾",
          events: ["command:new", "command:reset"],
          filePath: "/mock/workspace/hooks/session-memory/HOOK.md",
          handlerPath: "/mock/workspace/hooks/session-memory/handler.js",
          hookKey: "session-memory",
          name: "session-memory",
        },
        eligible,
      ),
      createMockHook(
        {
          baseDir: "/mock/workspace/hooks/command-logger",
          description: "Log all command events to a centralized audit file",
          emoji: "📝",
          events: ["command"],
          filePath: "/mock/workspace/hooks/command-logger/HOOK.md",
          handlerPath: "/mock/workspace/hooks/command-logger/handler.js",
          hookKey: "command-logger",
          name: "command-logger",
        },
        eligible,
      ),
    ],
    managedHooksDir: "/mock/.openclaw/hooks",
    workspaceDir: "/mock/workspace",
  });

  async function runSetupInternalHooks(params: {
    selected: string[];
    cfg?: OpenClawConfig;
    eligible?: boolean;
  }) {
    const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
    vi.mocked(buildWorkspaceHookStatus).mockReturnValue(
      createMockHookReport(params.eligible ?? true),
    );

    const cfg = params.cfg ?? {};
    const prompter = createMockPrompter(params.selected);
    const runtime = createMockRuntime();
    const result = await setupInternalHooks(cfg, runtime, prompter);
    return { cfg, prompter, result };
  }

  describe("setupInternalHooks", () => {
    it("should enable hooks when user selects them", async () => {
      const { result, prompter } = await runSetupInternalHooks({
        selected: ["session-memory"],
      });

      expect(result.hooks?.internal?.enabled).toBe(true);
      expect(result.hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
      expect(prompter.note).toHaveBeenCalledTimes(2);
      expect(prompter.multiselect).toHaveBeenCalledWith({
        message: "Enable hooks?",
        options: [
          { label: "Skip for now", value: "__skip__" },
          {
            hint: "Save session context to memory when /new or /reset command is issued",
            label: "💾 session-memory",
            value: "session-memory",
          },
          {
            hint: "Log all command events to a centralized audit file",
            label: "📝 command-logger",
            value: "command-logger",
          },
        ],
      });
    });

    it("should not enable hooks when user skips", async () => {
      const { result, prompter } = await runSetupInternalHooks({
        selected: ["__skip__"],
      });

      expect(result.hooks?.internal).toBeUndefined();
      expect(prompter.note).toHaveBeenCalledTimes(1);
    });

    it("should handle no eligible hooks", async () => {
      const { result, cfg, prompter } = await runSetupInternalHooks({
        eligible: false,
        selected: [],
      });

      expect(result).toEqual(cfg);
      expect(prompter.multiselect).not.toHaveBeenCalled();
      expect(prompter.note).toHaveBeenCalledWith(
        "No eligible hooks found. You can configure hooks later in your config.",
        "No Hooks Available",
      );
    });

    it("should preserve existing hooks config when enabled", async () => {
      const cfg: OpenClawConfig = {
        hooks: {
          enabled: true,
          path: "/webhook",
          token: "existing-token",
        },
      };
      const { result } = await runSetupInternalHooks({
        cfg,
        selected: ["session-memory"],
      });

      expect(result.hooks?.enabled).toBe(true);
      expect(result.hooks?.path).toBe("/webhook");
      expect(result.hooks?.token).toBe("existing-token");
      expect(result.hooks?.internal?.enabled).toBe(true);
      expect(result.hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
    });

    it("should preserve existing config when user skips", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: "/workspace" } },
      };
      const { result } = await runSetupInternalHooks({
        cfg,
        selected: ["__skip__"],
      });

      expect(result).toEqual(cfg);
      expect(result.agents?.defaults?.workspace).toBe("/workspace");
    });

    it("should show informative notes to user", async () => {
      const { prompter } = await runSetupInternalHooks({
        selected: ["session-memory"],
      });

      const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(noteCalls).toHaveLength(2);

      // First note should explain what hooks are
      expect(noteCalls[0][0]).toContain("Hooks let you automate actions");
      expect(noteCalls[0][0]).toContain("automate actions");

      // Second note should confirm configuration
      expect(noteCalls[1][0]).toContain("Enabled 1 hook: session-memory");
      expect(noteCalls[1][0]).toMatch(/(?:openclaw|openclaw)( --profile isolated)? hooks list/);
    });
  });
});
