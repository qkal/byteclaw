import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    },
  );
});

import { resolveOsSummary } from "./os-summary.js";

interface OsSummaryCase {
  name: string;
  platform: ReturnType<typeof os.platform>;
  release: string;
  arch: ReturnType<typeof os.arch>;
  swVersStdout?: string;
  expected: ReturnType<typeof resolveOsSummary>;
}

describe("resolveOsSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<OsSummaryCase>([
    {
      arch: "arm64",
      expected: {
        arch: "arm64",
        label: "macos 15.4 (arm64)",
        platform: "darwin",
        release: "24.0.0",
      },
      name: "formats darwin labels from sw_vers output",
      platform: "darwin" as const,
      release: "24.0.0",
      swVersStdout: " 15.4 \n",
    },
    {
      arch: "x64",
      expected: {
        arch: "x64",
        label: "macos 24.1.0 (x64)",
        platform: "darwin",
        release: "24.1.0",
      },
      name: "falls back to os.release when sw_vers output is blank",
      platform: "darwin" as const,
      release: "24.1.0",
      swVersStdout: "   ",
    },
    {
      arch: "x64",
      expected: {
        arch: "x64",
        label: "windows 10.0.26100 (x64)",
        platform: "win32",
        release: "10.0.26100",
      },
      name: "formats windows labels from os metadata",
      platform: "win32" as const,
      release: "10.0.26100",
    },
    {
      arch: "x64",
      expected: {
        arch: "x64",
        label: "linux 10.0.26100 (x64)",
        platform: "linux",
        release: "10.0.26100",
      },
      name: "formats non-darwin labels from os metadata",
      platform: "linux" as const,
      release: "10.0.26100",
    },
  ])("$name", ({ platform, release, arch, swVersStdout, expected }) => {
    vi.spyOn(os, "platform").mockReturnValue(platform);
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.spyOn(os, "arch").mockReturnValue(arch);
    if (platform === "darwin") {
      spawnSyncMock.mockReturnValue({
        output: [],
        pid: 1,
        signal: null,
        status: 0,
        stderr: "",
        stdout: swVersStdout ?? "",
      });
    }
    expect(resolveOsSummary()).toEqual(expected);
  });
});
