import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installScheduledTask, readScheduledTaskCommand } from "./schtasks.js";

const schtasksCalls: string[][] = [];
const schtasksResponses: { code: number; stdout: string; stderr: string }[] = [];

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    return schtasksResponses.shift() ?? { code: 0, stderr: "", stdout: "" };
  },
}));

beforeEach(() => {
  schtasksCalls.length = 0;
  schtasksResponses.length = 0;
});

describe("installScheduledTask", () => {
  async function withUserProfileDir(
    run: (tmpDir: string, env: Record<string, string>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-install-"));
    const env = {
      OPENCLAW_PROFILE: "default",
      USERPROFILE: tmpDir,
    };
    try {
      await run(tmpDir, env);
    } finally {
      await fs.rm(tmpDir, { force: true, recursive: true });
    }
  }

  it("writes quoted set assignments and escapes metacharacters", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const { scriptPath } = await installScheduledTask({
        env,
        environment: {
          OC_BANG: "!token!",
          OC_CARET: "a^b",
          OC_EMPTY: "",
          OC_INJECT: "safe & whoami | calc",
          OC_PERCENT: "%TEMP%",
          OC_QUOTE: 'he said "hi"',
        },
        programArguments: [
          "node",
          "gateway.js",
          "--display-name",
          "safe&whoami",
          "--percent",
          "%TEMP%",
          "--bang",
          "!token!",
        ],
        stdout: new PassThrough(),
        workingDirectory: "C:\\temp\\poc&calc",
      });

      const script = await fs.readFile(scriptPath, "utf8");
      expect(script).toContain(String.raw`cd /d "C:\temp\poc&calc"`);
      expect(script).toContain(
        'node gateway.js --display-name "safe&whoami" --percent "%%TEMP%%" --bang "^!token^!"',
      );
      expect(script).toContain('set "OC_INJECT=safe & whoami | calc"');
      expect(script).toContain('set "OC_CARET=a^^b"');
      expect(script).toContain('set "OC_PERCENT=%%TEMP%%"');
      expect(script).toContain('set "OC_BANG=^!token^!"');
      expect(script).toContain('set "OC_QUOTE=he said ^"hi^""');
      expect(script).not.toContain('set "OC_EMPTY=');
      expect(script).not.toContain("set OC_INJECT=");

      const parsed = await readScheduledTaskCommand(env);
      expect(parsed).toMatchObject({
        programArguments: [
          "node",
          "gateway.js",
          "--display-name",
          "safe&whoami",
          "--percent",
          "%TEMP%",
          "--bang",
          "!token!",
        ],
        workingDirectory: "C:\\temp\\poc&calc",
      });
      expect(parsed?.environment).toMatchObject({
        OC_BANG: "!token!",
        OC_CARET: "a^b",
        OC_INJECT: "safe & whoami | calc",
        OC_PERCENT: "%TEMP%",
        OC_QUOTE: 'he said "hi"',
      });
      expect(parsed?.environment).not.toHaveProperty("OC_EMPTY");

      expect(schtasksCalls[0]).toEqual(["/Query"]);
      expect(schtasksCalls[1]).toEqual(["/Query", "/TN", "OpenClaw Gateway"]);
      expect(schtasksCalls[2]?.[0]).toBe("/Change");
      expect(schtasksCalls[3]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("rejects line breaks in command arguments, env vars, and descriptions", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      await expect(
        installScheduledTask({
          env,
          environment: {},
          programArguments: ["node", "gateway.js", "bad\narg"],
          stdout: new PassThrough(),
        }),
      ).rejects.toThrow(/Command argument cannot contain CR or LF/);

      await expect(
        installScheduledTask({
          env,
          environment: { BAD: "line1\r\nline2" },
          programArguments: ["node", "gateway.js"],
          stdout: new PassThrough(),
        }),
      ).rejects.toThrow(/Environment variable value cannot contain CR or LF/);

      await expect(
        installScheduledTask({
          description: "bad\ndescription",
          env,
          environment: {},
          programArguments: ["node", "gateway.js"],
          stdout: new PassThrough(),
        }),
      ).rejects.toThrow(/Task description cannot contain CR or LF/);
    });
  });

  it("uses /Create when the task does not exist yet", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(
        { code: 0, stderr: "", stdout: "" },
        { code: 1, stderr: "ERROR: The system cannot find the file specified.", stdout: "" },
      );

      await installScheduledTask({
        env,
        environment: {},
        programArguments: ["node", "gateway.js"],
        stdout: new PassThrough(),
      });

      expect(schtasksCalls[0]).toEqual(["/Query"]);
      expect(schtasksCalls[1]).toEqual(["/Query", "/TN", "OpenClaw Gateway"]);
      expect(schtasksCalls[2]?.[0]).toBe("/Create");
      expect(schtasksCalls[3]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("falls back to /Create when /Change fails on an existing task", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(
        { code: 0, stderr: "", stdout: "" },
        { code: 0, stderr: "", stdout: "" },
        { code: 1, stderr: "ERROR: Access is denied.", stdout: "" },
      );

      await installScheduledTask({
        env,
        environment: {},
        programArguments: ["node", "gateway.js"],
        stdout: new PassThrough(),
      });

      expect(schtasksCalls[0]).toEqual(["/Query"]);
      expect(schtasksCalls[1]).toEqual(["/Query", "/TN", "OpenClaw Gateway"]);
      expect(schtasksCalls[2]?.[0]).toBe("/Change");
      expect(schtasksCalls[3]?.[0]).toBe("/Create");
      expect(schtasksCalls[4]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("throws when /Run fails after updating an existing task", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(
        { code: 0, stderr: "", stdout: "" },
        { code: 0, stderr: "", stdout: "" },
        { code: 0, stderr: "", stdout: "" },
        { code: 1, stderr: "ERROR: Access is denied.", stdout: "" },
      );

      await expect(
        installScheduledTask({
          env,
          environment: {},
          programArguments: ["node", "gateway.js"],
          stdout: new PassThrough(),
        }),
      ).rejects.toThrow("schtasks run failed: ERROR: Access is denied.");

      expect(schtasksCalls[0]).toEqual(["/Query"]);
      expect(schtasksCalls[1]).toEqual(["/Query", "/TN", "OpenClaw Gateway"]);
      expect(schtasksCalls[2]?.[0]).toBe("/Change");
      expect(schtasksCalls[3]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("throws when /Run fails after creating a new task", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(
        { code: 0, stderr: "", stdout: "" },
        { code: 1, stderr: "ERROR: The system cannot find the file specified.", stdout: "" },
        { code: 0, stderr: "", stdout: "" },
        { code: 1, stderr: "ERROR: Access is denied.", stdout: "" },
      );

      await expect(
        installScheduledTask({
          env,
          environment: {},
          programArguments: ["node", "gateway.js"],
          stdout: new PassThrough(),
        }),
      ).rejects.toThrow("schtasks run failed: ERROR: Access is denied.");

      expect(schtasksCalls[0]).toEqual(["/Query"]);
      expect(schtasksCalls[1]).toEqual(["/Query", "/TN", "OpenClaw Gateway"]);
      expect(schtasksCalls[2]?.[0]).toBe("/Create");
      expect(schtasksCalls[3]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("does not persist a frozen PATH snapshot into the generated task script", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const { scriptPath } = await installScheduledTask({
        env,
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          PATH: "C:\\Windows\\System32;C:\\Program Files\\Docker\\Docker\\resources\\bin",
        },
        programArguments: ["node", "gateway.js"],
        stdout: new PassThrough(),
      });

      const script = await fs.readFile(scriptPath, "utf8");
      expect(script).not.toContain('set "PATH=');
      expect(script).toContain('set "OPENCLAW_GATEWAY_PORT=18789"');
    });
  });
});
