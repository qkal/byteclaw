import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

const gatherDaemonStatus = vi.fn(
  async (_opts?: unknown): Promise<DaemonStatus> => ({
    extraServices: [],
    rpc: {
      ok: true,
      url: "ws://127.0.0.1:18789",
    },
    service: {
      label: "LaunchAgent",
      loaded: true,
      loadedText: "loaded",
      notLoadedText: "not loaded",
    },
  }),
);
const printDaemonStatus = vi.fn();

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _color: unknown, text: string) => text,
  isRich: () => false,
  theme: { error: "error" },
}));

vi.mock("./status.gather.js", () => ({
  gatherDaemonStatus: (opts: unknown) => gatherDaemonStatus(opts),
}));

vi.mock("./status.print.js", () => ({
  printDaemonStatus: (...args: unknown[]) => printDaemonStatus(...args),
}));

const { runDaemonStatus } = await import("./status.js");

describe("runDaemonStatus", () => {
  beforeEach(() => {
    gatherDaemonStatus.mockClear();
    printDaemonStatus.mockClear();
    resetRuntimeCapture();
  });

  it("exits when require-rpc is set and the probe fails", async () => {
    gatherDaemonStatus.mockResolvedValueOnce({
      extraServices: [],
      rpc: {
        error: "gateway closed",
        ok: false,
        url: "ws://127.0.0.1:18789",
      },
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
    });

    await expect(
      runDaemonStatus({
        json: false,
        probe: true,
        requireRpc: true,
        rpc: {},
      }),
    ).rejects.toThrow("__exit__:1");

    expect(printDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it("forwards require-rpc to daemon status gathering", async () => {
    await runDaemonStatus({
      json: false,
      probe: true,
      requireRpc: true,
      rpc: {},
    });

    expect(gatherDaemonStatus).toHaveBeenCalledWith({
      deep: false,
      probe: true,
      requireRpc: true,
      rpc: {},
    });
  });

  it("rejects require-rpc when probing is disabled", async () => {
    await expect(
      runDaemonStatus({
        json: false,
        probe: false,
        requireRpc: true,
        rpc: {},
      }),
    ).rejects.toThrow("__exit__:1");

    expect(gatherDaemonStatus).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("--require-rpc cannot be used with --no-probe");
  });
});
