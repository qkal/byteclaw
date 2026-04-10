import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentBootstrapHookContext,
  clearInternalHooks,
  registerInternalHook,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        content: "extra",
        missing: false,
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        content: "broken",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        missing: false,
        name: "EXTRA.md",
      } as unknown as WorkspaceBootstrapFile,
      {
        content: "broken",
        missing: false,
        name: "EXTRA.md",
        path: 123,
      } as unknown as WorkspaceBootstrapFile,
      {
        content: "broken",
        missing: false,
        name: "EXTRA.md",
        path: "   ",
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      warn: (message) => warnings.push(message),
      workspaceDir,
    });

    expect(
      files.every((file) => typeof file.path === "string" && file.path.trim().length > 0),
    ).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("uses heartbeat-only bootstrap files in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      contextMode: "lightweight",
      runKind: "heartbeat",
      workspaceDir,
    });

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      contextMode: "lightweight",
      runKind: "cron",
      workspaceDir,
    });

    expect(files).toEqual([]);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat prompt section is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");

    const files = await resolveBootstrapFilesForRun({
      config: {
        agents: {
          defaults: {
            heartbeat: {
              includeSystemPromptSection: false,
            },
          },
          list: [{ id: "main" }],
        },
      },
      workspaceDir,
    });

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(false);
    expect(files.some((file) => file.name === "AGENTS.md")).toBe(true);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat cadence is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");

    const files = await resolveBootstrapFilesForRun({
      config: {
        agents: {
          defaults: {
            heartbeat: {
              every: "0m",
            },
          },
          list: [{ id: "main" }],
        },
      },
      workspaceDir,
    });

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(false);
    expect(files.some((file) => file.name === "AGENTS.md")).toBe(true);
  });

  it("keeps HEARTBEAT.md for actual heartbeat runs even when the prompt section is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      config: {
        agents: {
          defaults: {
            heartbeat: {
              includeSystemPromptSection: false,
            },
          },
          list: [{ id: "main" }],
        },
      },
      runKind: "heartbeat",
      workspaceDir,
    });

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });
});

describe("hasCompletedBootstrapTurn", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "openclaw-bootstrap-turn-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  it("returns false when session file does not exist", async () => {
    expect(await hasCompletedBootstrapTurn(path.join(tmpDir, "missing.jsonl"))).toBe(false);
  });

  it("returns false for empty session files", async () => {
    const sessionFile = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false for header-only session files", async () => {
    const sessionFile = path.join(tmpDir, "header-only.jsonl");
    await fs.writeFile(sessionFile, `${JSON.stringify({ id: "s1", type: "session" })}\n`, "utf8");
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false when no assistant turn has been flushed yet", async () => {
    const sessionFile = path.join(tmpDir, "user-only.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ id: "s1", type: "session" }),
        JSON.stringify({ message: { content: "hello", role: "user" }, type: "message" }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false for assistant turns without a recorded full bootstrap marker", async () => {
    const sessionFile = path.join(tmpDir, "assistant-no-marker.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ id: "s1", type: "session" }),
        JSON.stringify({ message: { content: "hello", role: "user" }, type: "message" }),
        JSON.stringify({ message: { content: "hi", role: "assistant" }, type: "message" }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns true when a full bootstrap completion marker exists", async () => {
    const sessionFile = path.join(tmpDir, "full-bootstrap.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ message: { content: "hi", role: "assistant" }, type: "message" }),
        JSON.stringify({
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
          type: "custom",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("returns false when compaction happened after the last assistant turn", async () => {
    const sessionFile = path.join(tmpDir, "post-compaction.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
          type: "custom",
        }),
        JSON.stringify({ summary: "trimmed", type: "compaction" }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns true when a later full bootstrap marker happens after compaction", async () => {
    const sessionFile = path.join(tmpDir, "assistant-after-compaction.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
          type: "custom",
        }),
        JSON.stringify({ summary: "trimmed", type: "compaction" }),
        JSON.stringify({ message: { content: "new ask", role: "user" }, type: "message" }),
        JSON.stringify({ message: { content: "new reply", role: "assistant" }, type: "message" }),
        JSON.stringify({
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 2 },
          type: "custom",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("ignores malformed JSON lines", async () => {
    const sessionFile = path.join(tmpDir, "malformed.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        "{broken",
        JSON.stringify({
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
          type: "custom",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("finds a recent full bootstrap marker even when the scan starts mid-file", async () => {
    const sessionFile = path.join(tmpDir, "large-prefix.jsonl");
    const hugePrefix = "x".repeat(300 * 1024);
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ message: { content: hugePrefix, role: "user" }, type: "message" }),
        JSON.stringify({
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
          type: "custom",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("returns false for symbolic links", async () => {
    const realFile = path.join(tmpDir, "real.jsonl");
    const linkFile = path.join(tmpDir, "link.jsonl");
    await fs.writeFile(
      realFile,
      `${JSON.stringify({ customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, data: { timestamp: 1 }, type: "custom" })}\n`,
      "utf8",
    );
    await fs.symlink(realFile, linkFile);
    expect(await hasCompletedBootstrapTurn(linkFile)).toBe(false);
  });
});

describe("resolveContextInjectionMode", () => {
  it("defaults to always when config is missing", () => {
    expect(resolveContextInjectionMode(undefined)).toBe("always");
  });

  it("defaults to always when the setting is omitted", () => {
    expect(resolveContextInjectionMode({ agents: { defaults: {} } } as never)).toBe("always");
  });

  it("returns the configured continuation-skip mode", () => {
    expect(
      resolveContextInjectionMode({
        agents: { defaults: { contextInjection: "continuation-skip" } },
      } as never),
    ).toBe("continuation-skip");
  });
});
