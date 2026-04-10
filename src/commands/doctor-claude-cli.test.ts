import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  noteClaudeCliHealth,
  resolveClaudeCliProjectDirForWorkspace,
} from "./doctor-claude-cli.js";

function createStore(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return {
    profiles,
    version: 1,
  };
}

async function withTempHome<T>(
  run: (params: { homeDir: string; workspaceDir: string }) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-claude-cli-"));
  const homeDir = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    return await run({ homeDir, workspaceDir });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

describe("resolveClaudeCliProjectDirForWorkspace", () => {
  it("matches Claude's sanitized workspace project dir shape", () => {
    expect(
      resolveClaudeCliProjectDirForWorkspace({
        homeDir: "/Users/vincentkoc",
        workspaceDir: "/Users/vincentkoc/GIT/_Perso/openclaw/.openclaw/workspace",
      }),
    ).toBe(
      "/Users/vincentkoc/.claude/projects/-Users-vincentkoc-GIT--Perso-openclaw--openclaw-workspace",
    );
  });
});

describe("noteClaudeCliHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays quiet when Claude CLI is not configured or detected", () => {
    const noteFn = vi.fn();
    noteClaudeCliHealth(
      {},
      {
        noteFn,
        readClaudeCliCredentials: () => null,
        store: createStore(),
      },
    );
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("reports a healthy claude-cli setup with the resolved Claude project dir", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const projectDir = resolveClaudeCliProjectDirForWorkspace({ homeDir, workspaceDir });
      fs.mkdirSync(projectDir, { recursive: true });

      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
          },
        },
        {
          homeDir,
          noteFn,
          readClaudeCliCredentials: () => ({
            expires: Date.now() + 60_000,
            type: "oauth",
          }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
          store: createStore({
            [CLAUDE_CLI_PROFILE_ID]: {
              access: "token-a",
              expires: Date.now() + 60_000,
              provider: "claude-cli",
              refresh: "token-r",
              type: "oauth",
            },
          }),
          workspaceDir,
        },
      );

      expect(noteFn).toHaveBeenCalledTimes(1);
      expect(noteFn.mock.calls[0]?.[1]).toBe("Claude CLI");
      const body = String(noteFn.mock.calls[0]?.[0]);
      expect(body).toContain("Binary: /opt/homebrew/bin/claude.");
      expect(body).toContain("Headless Claude auth: OK (oauth).");
      expect(body).toContain(
        `OpenClaw auth profile: ${CLAUDE_CLI_PROFILE_ID} (provider claude-cli).`,
      );
      expect(body).toContain("Workspace:");
      expect(body).toContain("(writable).");
      expect(body).toContain("Claude project dir:");
      expect(body).toContain("(present).");
    });
  });

  it("explains the exact bad wiring when the claude-cli auth profile is missing", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
          },
        },
        {
          homeDir,
          noteFn,
          readClaudeCliCredentials: () => ({
            expires: Date.now() + 60_000,
            type: "oauth",
          }),
          resolveCommandPath: () => "/opt/homebrew/bin/claude",
          store: createStore(),
          workspaceDir,
        },
      );

      const body = String(noteFn.mock.calls[0]?.[0]);
      expect(body).toContain("Headless Claude auth: OK (oauth).");
      expect(body).toContain(`OpenClaw auth profile: missing (${CLAUDE_CLI_PROFILE_ID})`);
      expect(body).toContain(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      );
      expect(body).toContain(
        "not created yet; it appears after the first Claude CLI turn in this workspace",
      );
    });
  });

  it("warns when Claude auth is not readable headlessly", async () => {
    await withTempHome(({ homeDir, workspaceDir }) => {
      const noteFn = vi.fn();
      noteClaudeCliHealth(
        {
          agents: {
            defaults: {
              model: { primary: "claude-cli/claude-sonnet-4-6" },
            },
          },
        },
        {
          homeDir,
          noteFn,
          readClaudeCliCredentials: () => null,
          resolveCommandPath: () => undefined,
          store: createStore(),
          workspaceDir,
        },
      );

      const body = String(noteFn.mock.calls[0]?.[0]);
      expect(body).toContain('Binary: command "claude" was not found on PATH.');
      expect(body).toContain("Headless Claude auth: unavailable without interactive prompting.");
      expect(body).toContain("claude auth login");
    });
  });
});
