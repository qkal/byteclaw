import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../command-format.js";
import { printDaemonStatus } from "./status.print.js";

const runtime = vi.hoisted(() => ({
  error: vi.fn<(line: string) => void>(),
  log: vi.fn<(line: string) => void>(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../../terminal/theme.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../terminal/theme.js")>("../../terminal/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

vi.mock("../../gateway/control-ui-links.js", () => ({
  resolveControlUiLinks: () => ({ httpUrl: "http://127.0.0.1:18789" }),
}));

vi.mock("../../daemon/inspect.js", () => ({
  renderGatewayServiceCleanupHints: () => [],
}));

vi.mock("../../daemon/launchd.js", () => ({
  resolveGatewayLogPaths: () => ({
    stderrPath: "/tmp/gateway.err.log",
    stdoutPath: "/tmp/gateway.out.log",
  }),
}));

vi.mock("../../daemon/systemd-hints.js", () => ({
  isSystemdUnavailableDetail: () => false,
  renderSystemdUnavailableHints: () => [],
}));

vi.mock("../../infra/wsl.js", () => ({
  isWSLEnv: () => false,
}));

vi.mock("./shared.js", () => ({
  createCliStatusTextStyles: () => ({
    accent: (text: string) => text,
    errorText: (text: string) => text,
    infoText: (text: string) => text,
    label: (text: string) => text,
    okText: (text: string) => text,
    rich: false,
    warnText: (text: string) => text,
  }),
  filterDaemonEnv: () => ({}),
  formatRuntimeStatus: () => "running (pid 8000)",
  renderRuntimeHints: () => [],
  resolveDaemonContainerContext: () => null,
  resolveRuntimeStatusColor: () => "",
  safeDaemonEnv: () => [],
}));

vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => ["127.0.0.1:18789"],
}));

describe("printDaemonStatus", () => {
  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
  });

  it("prints stale gateway pid guidance when runtime does not own the listener", () => {
    printDaemonStatus(
      {
        extraServices: [],
        gateway: {
          bindHost: "127.0.0.1",
          bindMode: "loopback",
          port: 18_789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        health: {
          healthy: false,
          staleGatewayPids: [9000],
        },
        logFile: "/tmp/openclaw.log",
        port: {
          hints: [],
          listeners: [{ address: "127.0.0.1:18789", pid: 9000, ppid: 8999 }],
          port: 18_789,
          status: "busy",
        },
        rpc: {
          error: "gateway closed (1006 abnormal closure (no close frame))",
          ok: false,
          url: "ws://127.0.0.1:18789",
        },
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { pid: 8000, status: "running" },
        },
      },
      { json: false },
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway runtime PID does not own the listening port"),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(formatCliCommand("openclaw gateway restart")),
    );
  });
});
