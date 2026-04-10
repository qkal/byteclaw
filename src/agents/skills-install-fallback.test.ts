import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  hasBinaryMock,
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../security/skill-scanner.js", async () => ({
  ...(await vi.importActual<typeof import("../security/skill-scanner.js")>(
    "../security/skill-scanner.js",
  )),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

vi.mock("../shared/config-eval.js", async () => {
  const actual = await vi.importActual<typeof import("../shared/config-eval.js")>(
    "../shared/config-eval.js",
  );
  return {
    ...actual,
    hasBinary: (bin: string) => hasBinaryMock(bin),
  };
});

vi.mock("../infra/brew.js", () => ({
  resolveBrewExecutable: () => undefined,
}));

let installSkill: typeof import("./skills-install.js").installSkill;
let buildWorkspaceSkillStatus: typeof import("./skills-status.js").buildWorkspaceSkillStatus;

async function loadSkillsInstallModulesForTest() {
  ({ installSkill } = await import("./skills-install.js"));
  ({ buildWorkspaceSkillStatus } = await import("./skills-status.js"));
}

async function writeSkillWithInstallers(
  workspaceDir: string,
  name: string,
  installSpecs: Record<string, string>[],
): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: ${JSON.stringify({ openclaw: { install: installSpecs } })}
---

# ${name}
`,
    "utf8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf8");
  return skillDir;
}

async function writeSkillWithInstaller(
  workspaceDir: string,
  name: string,
  kind: string,
  extra: Record<string, string>,
): Promise<string> {
  return writeSkillWithInstallers(workspaceDir, name, [{ id: "deps", kind, ...extra }]);
}

function mockAvailableBinaries(binaries: string[]) {
  const available = new Set(binaries);
  hasBinaryMock.mockImplementation((bin: string) => available.has(bin));
}

function assertNoAptGetFallbackCalls() {
  const aptCalls = runCommandWithTimeoutMock.mock.calls.filter(
    (call) => Array.isArray(call[0]) && (call[0] as string[]).includes("apt-get"),
  );
  expect(aptCalls).toHaveLength(0);
}

describe("skills-install fallback edge cases", () => {
  let workspaceDir: string;

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-test-"));
    await writeSkillWithInstaller(workspaceDir, "go-tool-single", "go", {
      module: "example.com/tool@latest",
    });
    await writeSkillWithInstallers(workspaceDir, "go-tool-multi", [
      { formula: "go", id: "brew", kind: "brew" },
      { id: "go", kind: "go", module: "example.com/tool@latest" },
    ]);
    await writeSkillWithInstaller(workspaceDir, "py-tool", "uv", {
      package: "example-package",
    });
    await loadSkillsInstallModulesForTest();
  });

  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    hasBinaryMock.mockClear();
    scanDirectoryWithSummaryMock.mockResolvedValue({ critical: 0, findings: [], warn: 0 });
  });

  afterAll(async () => {
    await fs.rm(workspaceDir, { force: true, recursive: true }).catch(() => undefined);
  });

  it("handles sudo probe failures for go install without apt fallback", async () => {
    for (const testCase of [
      {
        assert: (result: { message: string; stderr: string }) => {
          expect(result.message).toContain("sudo");
          expect(result.message).toContain("https://go.dev/doc/install");
        },
        label: "sudo returns password required",
        setup: () =>
          runCommandWithTimeoutMock.mockResolvedValueOnce({
            code: 1,
            stderr: "sudo: a password is required",
            stdout: "",
          }),
      },
      {
        assert: (result: { message: string; stderr: string }) => {
          expect(result.message).toContain("sudo is not usable");
          expect(result.stderr).toContain("Executable not found");
        },
        label: "sudo probe throws executable-not-found",
        setup: () =>
          runCommandWithTimeoutMock.mockRejectedValueOnce(
            new Error('Executable not found in $PATH: "sudo"'),
          ),
      },
    ]) {
      runCommandWithTimeoutMock.mockClear();
      mockAvailableBinaries(["apt-get", "sudo"]);
      testCase.setup();

      const result = await installSkill({
        installId: "deps",
        skillName: "go-tool-single",
        workspaceDir,
      });

      expect(result.ok, testCase.label).toBe(false);
      testCase.assert(result);
      expect(runCommandWithTimeoutMock, testCase.label).toHaveBeenCalledWith(
        ["sudo", "-n", "true"],
        expect.objectContaining({ timeoutMs: 5000 }),
      );
      assertNoAptGetFallbackCalls();
    }
  });

  it("status-selected go installer fails gracefully when apt fallback needs sudo", async () => {
    mockAvailableBinaries(["apt-get", "sudo"]);

    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stderr: "sudo: a password is required",
      stdout: "",
    });

    const status = buildWorkspaceSkillStatus(workspaceDir);
    const skill = status.skills.find((entry) => entry.name === "go-tool-multi");
    expect(skill?.install[0]?.id).toBe("go");

    const result = await installSkill({
      installId: skill?.install[0]?.id ?? "",
      skillName: "go-tool-multi",
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("sudo is not usable");
  });

  it("uv not installed and no brew returns helpful error without curl auto-install", async () => {
    mockAvailableBinaries(["curl"]);

    const result = await installSkill({
      installId: "deps",
      skillName: "py-tool",
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("https://docs.astral.sh/uv/getting-started/installation/");

    // Verify NO curl command was attempted (no auto-install)
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("preserves system uv/python env vars when running uv installs", async () => {
    mockAvailableBinaries(["uv"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "ok",
    });

    const envSnapshot = captureEnv([
      "UV_PYTHON",
      "UV_INDEX_URL",
      "PIP_INDEX_URL",
      "PYTHONPATH",
      "VIRTUAL_ENV",
    ]);
    try {
      process.env.UV_PYTHON = "/tmp/attacker-python";
      process.env.UV_INDEX_URL = "https://example.invalid/simple";
      process.env.PIP_INDEX_URL = "https://example.invalid/pip";
      process.env.PYTHONPATH = "/tmp/attacker-pythonpath";
      process.env.VIRTUAL_ENV = "/tmp/attacker-venv";

      const result = await installSkill({
        installId: "deps",
        skillName: "py-tool",
        timeoutMs: 10_000,
        workspaceDir,
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["uv", "tool", "install", "example-package"],
        expect.objectContaining({
          timeoutMs: 10_000,
        }),
      );
      const firstCall = runCommandWithTimeoutMock.mock.calls[0] as
        | [string[], { timeoutMs?: number; env?: Record<string, string | undefined> }]
        | undefined;
      const envArg = firstCall?.[1]?.env;
      expect(envArg).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
