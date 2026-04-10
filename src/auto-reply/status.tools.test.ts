import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildCommandsMessage, buildHelpMessage, buildToolsMessage } from "./status.js";

vi.mock("../plugins/commands.js", () => ({
  listPluginCommands: () => [],
}));

describe("tools product copy", () => {
  it("mentions /tools in command discovery copy", () => {
    const cfg = {
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig;

    expect(buildCommandsMessage(cfg)).toContain("/tools - List available runtime tools.");
    expect(buildCommandsMessage(cfg)).toContain("More: /tools for available capabilities");
    expect(buildHelpMessage(cfg)).toContain("/tools for available capabilities");
    expect(buildHelpMessage(cfg)).toContain("/tasks");
  });

  it("formats built-in and plugin tools for end users", () => {
    const text = buildToolsMessage({
      agentId: "main",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              description: "Run shell commands",
              id: "exec",
              label: "Exec",
              rawDescription: "Run shell commands",
              source: "core",
            },
            {
              description: "Search the web",
              id: "web_search",
              label: "Web Search",
              rawDescription: "Search the web",
              source: "core",
            },
          ],
        },
        {
          id: "plugin",
          label: "Connected tools",
          source: "plugin",
          tools: [
            {
              description: "Search internal documentation",
              id: "docs_lookup",
              label: "Docs Lookup",
              pluginId: "docs",
              rawDescription: "Search internal documentation",
              source: "plugin",
            },
          ],
        },
      ],
      profile: "coding",
    });

    expect(text).toContain("Available tools");
    expect(text).toContain("Profile: coding");
    expect(text).toContain("Built-in tools");
    expect(text).toContain("exec, web_search");
    expect(text).toContain("Connected tools");
    expect(text).toContain("docs_lookup (docs)");
    expect(text).toContain("Use /tools verbose for descriptions.");
    expect(text).not.toContain("unavailable right now");
  });

  it("keeps detailed descriptions in verbose mode", () => {
    const text = buildToolsMessage(
      {
        agentId: "main",
        groups: [
          {
            id: "core",
            label: "Built-in tools",
            source: "core",
            tools: [
              {
                description: "Run shell commands",
                id: "exec",
                label: "Exec",
                rawDescription: "Run shell commands",
                source: "core",
              },
            ],
          },
        ],
        profile: "minimal",
      },
      { verbose: true },
    );

    expect(text).toContain("What this agent can use right now:");
    expect(text).toContain("Profile: minimal");
    expect(text).toContain("Exec - Run shell commands");
    expect(text).toContain("Tool availability depends on this agent's configuration.");
    expect(text).not.toContain("unavailable right now");
  });

  it("trims verbose output before schema-like doc blocks", () => {
    const text = buildToolsMessage(
      {
        agentId: "main",
        groups: [
          {
            id: "core",
            label: "Built-in tools",
            source: "core",
            tools: [
              {
                description: "Schedule and manage cron jobs.",
                id: "cron",
                label: "Cron",
                rawDescription:
                  'Manage Gateway cron jobs and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check cron scheduler status\nJOB SCHEMA:\n{ ... }',
                source: "core",
              },
            ],
          },
        ],
        profile: "coding",
      },
      { verbose: true },
    );

    expect(text).toContain(
      'Cron - Manage Gateway cron jobs and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.',
    );
    expect(text).not.toContain("ACTIONS:");
    expect(text).not.toContain("JOB SCHEMA:");
  });

  it("returns the empty state when no tools are available", () => {
    expect(
      buildToolsMessage({
        agentId: "main",
        groups: [],
        profile: "full",
      }),
    ).toBe("No tools are available for this agent right now.\n\nProfile: full");
  });
});
