import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedLobsterRunner, resolveLobsterCwd } from "./lobster-runner.js";

describe("resolveLobsterCwd", () => {
  it("defaults to the current working directory", () => {
    expect(resolveLobsterCwd(undefined)).toBe(process.cwd());
  });

  it("keeps relative paths inside the repo root", () => {
    expect(resolveLobsterCwd("extensions/lobster")).toBe(
      path.resolve(process.cwd(), "extensions/lobster"),
    );
  });
});

describe("createEmbeddedLobsterRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs inline pipelines through the embedded runtime", async () => {
    const runtime = {
      resumeToolRequest: vi.fn(),
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        output: [{ hello: "world" }],
        protocolVersion: 1,
        requiresApproval: null,
        status: "ok",
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      cwd: process.cwd(),
      maxStdoutBytes: 4096,
      pipeline: "exec --json=true echo hi",
      timeoutMs: 2000,
    });

    expect(runtime.runToolRequest).toHaveBeenCalledTimes(1);
    expect(runtime.runToolRequest).toHaveBeenCalledWith({
      ctx: expect.objectContaining({
        cwd: process.cwd(),
        mode: "tool",
        signal: expect.any(AbortSignal),
      }),
      pipeline: "exec --json=true echo hi",
    });
    expect(envelope).toEqual({
      ok: true,
      output: [{ hello: "world" }],
      requiresApproval: null,
      status: "ok",
    });
  });

  it("detects workflow files and parses argsJson", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        resumeToolRequest: vi.fn(),
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          output: [],
          protocolVersion: 1,
          requiresApproval: null,
          status: "ok",
        }),
      };

      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await runner.run({
        action: "run",
        argsJson: '{"limit":3}',
        cwd: tempDir,
        maxStdoutBytes: 4096,
        pipeline: "workflow.lobster",
        timeoutMs: 2000,
      });

      expect(runtime.runToolRequest).toHaveBeenCalledWith({
        args: { limit: 3 },
        ctx: expect.objectContaining({
          cwd: tempDir,
          mode: "tool",
        }),
        filePath: workflowPath,
      });
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        resumeToolRequest: vi.fn(),
        runToolRequest: vi.fn(),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await expect(
        runner.run({
          action: "run",
          argsJson: "{bad",
          cwd: tempDir,
          maxStdoutBytes: 4096,
          pipeline: "workflow.lobster",
          timeoutMs: 2000,
        }),
      ).rejects.toThrow("run --args-json must be valid JSON");
      expect(runtime.runToolRequest).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("throws when the embedded runtime returns an error envelope", async () => {
    const runtime = {
      resumeToolRequest: vi.fn(),
      runToolRequest: vi.fn().mockResolvedValue({
        error: {
          message: "boom",
          type: "runtime_error",
        },
        ok: false,
        protocolVersion: 1,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        cwd: process.cwd(),
        maxStdoutBytes: 4096,
        pipeline: "exec --json=true echo hi",
        timeoutMs: 2000,
      }),
    ).rejects.toThrow("boom");
  });

  it("routes resume through the embedded runtime", async () => {
    const runtime = {
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        output: [],
        protocolVersion: 1,
        requiresApproval: null,
        status: "cancelled",
      }),
      runToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "resume",
      approve: false,
      cwd: process.cwd(),
      maxStdoutBytes: 4096,
      timeoutMs: 2000,
      token: "resume-token",
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledWith({
      approved: false,
      ctx: expect.objectContaining({
        cwd: process.cwd(),
        mode: "tool",
        signal: expect.any(AbortSignal),
      }),
      token: "resume-token",
    });
    expect(envelope).toEqual({
      ok: true,
      output: [],
      requiresApproval: null,
      status: "cancelled",
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    const runtime = {
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        output: [],
        protocolVersion: 1,
        requiresApproval: null,
        status: "cancelled",
      }),
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        output: [],
        protocolVersion: 1,
        requiresApproval: null,
        status: "ok",
      }),
    };
    const loadRuntime = vi.fn().mockResolvedValue(runtime);

    const runner = createEmbeddedLobsterRunner({ loadRuntime });

    await runner.run({
      action: "run",
      cwd: process.cwd(),
      maxStdoutBytes: 4096,
      pipeline: "exec --json=true echo hi",
      timeoutMs: 2000,
    });
    await runner.run({
      action: "resume",
      approve: false,
      cwd: process.cwd(),
      maxStdoutBytes: 4096,
      timeoutMs: 2000,
      token: "resume-token",
    });

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("requires a pipeline for run", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        resumeToolRequest: vi.fn(),
        runToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "run",
        cwd: process.cwd(),
        maxStdoutBytes: 4096,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/pipeline required/);
  });

  it("requires token and approve for resume", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        resumeToolRequest: vi.fn(),
        runToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "resume",
        approve: true,
        cwd: process.cwd(),
        maxStdoutBytes: 4096,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/token required/);

    await expect(
      runner.run({
        action: "resume",
        cwd: process.cwd(),
        maxStdoutBytes: 4096,
        timeoutMs: 2000,
        token: "resume-token",
      }),
    ).rejects.toThrow(/approve required/);
  });

  it("aborts long-running embedded work", async () => {
    const runtime = {
      resumeToolRequest: vi.fn(),
      runToolRequest: vi.fn(
        async ({ ctx }: { ctx?: { signal?: AbortSignal } }) =>
          await new Promise((resolve, reject) => {
            ctx?.signal?.addEventListener("abort", () => {
              reject(ctx.signal?.reason ?? new Error("aborted"));
            });
            setTimeout(
              () => resolve({ ok: true, output: [], requiresApproval: null, status: "ok" }),
              500,
            );
          }),
      ),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        cwd: process.cwd(),
        maxStdoutBytes: 4096,
        pipeline: "exec --json=true echo hi",
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out|aborted/);
  });
});
