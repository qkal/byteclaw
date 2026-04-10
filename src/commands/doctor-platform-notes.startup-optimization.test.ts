import { describe, expect, it, vi } from "vitest";
import { noteStartupOptimizationHints } from "./doctor-platform-notes.js";

describe("noteStartupOptimizationHints", () => {
  it("does not warn when compile cache and no-respawn are configured", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
        OPENCLAW_NO_RESPAWN: "1",
      },
      { arch: "arm64", noteFn, platform: "linux", totalMemBytes: 4 * 1024 ** 3 },
    );

    expect(noteFn).not.toHaveBeenCalled();
  });

  it("warns when compile cache is under /tmp and no-respawn is not set", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
      },
      { arch: "arm64", noteFn, platform: "linux", totalMemBytes: 4 * 1024 ** 3 },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Startup optimization");
    expect(message).toContain("NODE_COMPILE_CACHE points to /tmp");
    expect(message).toContain("OPENCLAW_NO_RESPAWN is not set to 1");
    expect(message).toContain("export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache");
    expect(message).toContain("export OPENCLAW_NO_RESPAWN=1");
  });

  it("warns when compile cache is disabled via env override", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/var/tmp/openclaw-compile-cache",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_NO_RESPAWN: "1",
      },
      { arch: "arm64", noteFn, platform: "linux", totalMemBytes: 4 * 1024 ** 3 },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message] = noteFn.mock.calls[0] ?? [];
    expect(message).toContain("NODE_DISABLE_COMPILE_CACHE is set");
    expect(message).toContain("unset NODE_DISABLE_COMPILE_CACHE");
  });

  it("skips startup optimization note on win32", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
      },
      { arch: "arm64", noteFn, platform: "win32", totalMemBytes: 4 * 1024 ** 3 },
    );

    expect(noteFn).not.toHaveBeenCalled();
  });

  it("skips startup optimization note on non-target linux hosts", () => {
    const noteFn = vi.fn();

    noteStartupOptimizationHints(
      {
        NODE_COMPILE_CACHE: "/tmp/openclaw-compile-cache",
      },
      { arch: "x64", noteFn, platform: "linux", totalMemBytes: 32 * 1024 ** 3 },
    );

    expect(noteFn).not.toHaveBeenCalled();
  });
});
