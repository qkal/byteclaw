import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const runExec = vi.fn();
const note = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
  runExec,
}));

vi.mock("../agents/sandbox.js", () => ({
  DEFAULT_SANDBOX_BROWSER_IMAGE: "browser-image",
  DEFAULT_SANDBOX_COMMON_IMAGE: "common-image",
  DEFAULT_SANDBOX_IMAGE: "default-image",
  resolveSandboxScope: vi.fn(() => "shared"),
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

const { maybeRepairSandboxImages } = await import("./doctor-sandbox.js");

describe("maybeRepairSandboxImages", () => {
  const mockRuntime: RuntimeEnv = {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };

  const mockPrompter: DoctorPrompter = {
    confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
    repairMode: {
      canPrompt: true,
      nonInteractive: false,
      shouldForce: false,
      shouldRepair: false,
      updateInProgress: false,
    } satisfies DoctorRepairMode,
  } as unknown as DoctorPrompter;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createSandboxConfig(mode: "off" | "all" | "non-main"): OpenClawConfig {
    return {
      agents: {
        defaults: {
          sandbox: {
            mode,
          },
        },
      },
    };
  }

  async function runSandboxRepair(params: {
    mode: "off" | "all" | "non-main";
    dockerAvailable: boolean;
  }) {
    if (params.dockerAvailable) {
      runExec.mockResolvedValue({ stderr: "", stdout: "24.0.0" });
    } else {
      runExec.mockRejectedValue(new Error("Docker not installed"));
    }
    await maybeRepairSandboxImages(createSandboxConfig(params.mode), mockRuntime, mockPrompter);
  }

  it("warns when sandbox mode is enabled but Docker is not available", async () => {
    await runSandboxRepair({ dockerAvailable: false, mode: "non-main" });

    // The warning should clearly indicate sandbox is enabled but won't work
    expect(note).toHaveBeenCalled();
    const noteCall = note.mock.calls[0];
    const message = noteCall[0] as string;

    // The message should warn that sandbox mode won't function, not just "skipping checks"
    expect(message).toMatch(/sandbox.*mode.*enabled|sandbox.*won.*work|docker.*required/i);
    // Should NOT just say "skipping sandbox image checks" - that's too mild
    expect(message).not.toBe("Docker not available; skipping sandbox image checks.");
  });

  it("warns when sandbox mode is 'all' but Docker is not available", async () => {
    await runSandboxRepair({ dockerAvailable: false, mode: "all" });

    expect(note).toHaveBeenCalled();
    const noteCall = note.mock.calls[0];
    const message = noteCall[0] as string;

    // Should warn about the impact on sandbox functionality
    expect(message).toMatch(/sandbox|docker/i);
  });

  it("does not warn when sandbox mode is off", async () => {
    await runSandboxRepair({ dockerAvailable: false, mode: "off" });

    // No warning needed when sandbox is off
    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when Docker is available", async () => {
    await runSandboxRepair({ dockerAvailable: true, mode: "non-main" });

    // May have other notes about images, but not the Docker unavailable warning
    const dockerUnavailableWarning = note.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].toLowerCase().includes("docker not available"),
    );
    expect(dockerUnavailableWarning).toBeUndefined();
  });
});
