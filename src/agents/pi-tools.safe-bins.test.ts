import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import { captureEnv } from "../test-utils/env.js";

const bundledPluginsDirSnapshot = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR"]);

beforeAll(() => {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(
    os.tmpdir(),
    "openclaw-test-no-bundled-extensions",
  );
});

afterAll(() => {
  bundledPluginsDirSnapshot.restore();
});

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 50),
  };
});

vi.mock("../plugins/tools.js", () => ({
  copyPluginToolMeta: vi.fn((_from, to) => to),
  getPluginToolMeta: () => undefined,
  resolvePluginTools: () => [],
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  const approvals: ExecApprovalsResolved = {
    agent: {
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
      security: "allowlist",
    },
    agentSources: {
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
      security: "defaults.security",
    },
    allowlist: [],
    defaults: {
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
      security: "allowlist",
    },
    file: {
      agents: {},
      defaults: {
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
        security: "allowlist",
      },
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      version: 1,
    },
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

const { createOpenClawCodingTools } = await import("./pi-tools.js");

interface ExecToolResult {
  content: { type: string; text?: string }[];
  details?: { status?: string };
}

interface ExecTool {
  execute(
    callId: string,
    params: {
      command: string;
      workdir: string;
      env?: Record<string, string>;
    },
  ): Promise<ExecToolResult>;
}

async function createSafeBinsExecTool(params: {
  tmpPrefix: string;
  safeBins: string[];
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  files?: { name: string; contents: string }[];
}): Promise<{ tmpDir: string; execTool: ExecTool }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), params.tmpPrefix));
  for (const file of params.files ?? []) {
    fs.writeFileSync(path.join(tmpDir, file.name), file.contents, "utf8");
  }

  const cfg: OpenClawConfig = {
    tools: {
      exec: {
        ask: "off",
        host: "gateway",
        safeBinProfiles: params.safeBinProfiles,
        safeBins: params.safeBins,
        security: "allowlist",
      },
    },
  };

  const tools = createOpenClawCodingTools({
    agentDir: path.join(tmpDir, "agent"),
    config: cfg,
    sessionKey: "agent:main:main",
    workspaceDir: tmpDir,
  });
  const execTool = tools.find((tool) => tool.name === "exec");
  if (!execTool) {
    throw new Error("exec tool missing from coding tools");
  }
  return { execTool: execTool as ExecTool, tmpDir };
}

async function withSafeBinsExecTool(
  params: Parameters<typeof createSafeBinsExecTool>[0],
  run: (ctx: Awaited<ReturnType<typeof createSafeBinsExecTool>>) => Promise<void>,
) {
  if (process.platform === "win32") {
    return;
  }
  const ctx = await createSafeBinsExecTool(params);
  try {
    await run(ctx);
  } finally {
    fs.rmSync(ctx.tmpDir, { force: true, recursive: true });
  }
}

describe("createOpenClawCodingTools safeBins", () => {
  it("threads tools.exec.safeBins into exec allowlist checks", async () => {
    await withSafeBinsExecTool(
      {
        safeBinProfiles: {
          echo: { maxPositional: 1 },
        },
        safeBins: ["echo"],
        tmpPrefix: "openclaw-safe-bins-",
      },
      async ({ tmpDir, execTool }) => {
        const marker = `safe-bins-${Date.now()}`;
        const result = await execTool.execute("call1", {
          command: `echo ${marker}`,
          workdir: tmpDir,
        });
        const text = result.content.find((content) => content.type === "text")?.text ?? "";

        const resultDetails = result.details as { status?: string };
        expect(resultDetails.status).toBe("completed");
        expect(text).toContain(marker);
      },
    );
  });

  it("rejects unprofiled custom safe-bin entries", async () => {
    await withSafeBinsExecTool(
      {
        safeBins: ["echo"],
        tmpPrefix: "openclaw-safe-bins-unprofiled-",
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "echo hello",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });

  it("does not allow env var expansion to smuggle file args via safeBins", async () => {
    await withSafeBinsExecTool(
      {
        files: [{ contents: "TOP_SECRET\n", name: "secret.txt" }],
        safeBins: ["head", "wc"],
        tmpPrefix: "openclaw-safe-bins-expand-",
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "head $FOO ; wc -l",
            env: { FOO: "secret.txt" },
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });

  it("blocks sort output/compress bypass attempts in safeBins mode", async () => {
    await withSafeBinsExecTool(
      {
        files: [{ contents: "x\n", name: "existing.txt" }],
        safeBins: ["sort"],
        tmpPrefix: "openclaw-safe-bins-sort-",
      },
      async ({ tmpDir, execTool }) => {
        const run = async (command: string) => {
          try {
            const result = await execTool.execute("call-oracle", { command, workdir: tmpDir });
            const text = result.content.find((content) => content.type === "text")?.text ?? "";
            const resultDetails = result.details as { status?: string };
            return { kind: "result" as const, status: resultDetails.status, text };
          } catch (error) {
            return { kind: "error" as const, message: String(error) };
          }
        };

        const existing = await run("sort -o existing.txt");
        const missing = await run("sort -o missing.txt");
        expect(existing).toEqual(missing);

        const outputFlagCases = [
          { command: "sort -oblocked-short.txt", target: "blocked-short.txt" },
          { command: "sort --output=blocked-long.txt", target: "blocked-long.txt" },
        ] as const;
        for (const [index, testCase] of outputFlagCases.entries()) {
          await expect(
            execTool.execute(`call-output-${index + 1}`, {
              command: testCase.command,
              workdir: tmpDir,
            }),
          ).rejects.toThrow("exec denied: allowlist miss");
          expect(fs.existsSync(path.join(tmpDir, testCase.target))).toBe(false);
        }

        await expect(
          execTool.execute("call1", {
            command: "sort --compress-program=sh",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });

  it("blocks shell redirection metacharacters in safeBins mode", async () => {
    await withSafeBinsExecTool(
      {
        files: [{ contents: "line1\nline2\n", name: "source.txt" }],
        safeBins: ["head"],
        tmpPrefix: "openclaw-safe-bins-redirect-",
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "head -n 1 source.txt > blocked-redirect.txt",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
        expect(fs.existsSync(path.join(tmpDir, "blocked-redirect.txt"))).toBe(false);
      },
    );
  });

  it("blocks grep recursive flags from reading cwd via safeBins", async () => {
    await withSafeBinsExecTool(
      {
        files: [{ contents: "SAFE_BINS_RECURSIVE_SHOULD_NOT_LEAK\n", name: "secret.txt" }],
        safeBins: ["grep"],
        tmpPrefix: "openclaw-safe-bins-grep-",
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "grep -R SAFE_BINS_RECURSIVE_SHOULD_NOT_LEAK",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });
});
