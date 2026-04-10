import { afterEach, describe, expect, it, vi } from "vitest";
import { configHandlers, resolveConfigOpenCommand } from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: Object.assign(execFileMock, {
        __promisify__: vi.fn(),
      }) as typeof import("node:child_process").execFile,
    },
  );
});

function invokeExecFileCallback(args: unknown[], error: Error | null) {
  const callback = args.at(-1);
  expect(callback).toEqual(expect.any(Function));
  (callback as (error: Error | null) => void)(error);
}

describe("resolveConfigOpenCommand", () => {
  it("uses open on macOS", () => {
    expect(resolveConfigOpenCommand("/tmp/openclaw.json", "darwin")).toEqual({
      args: ["/tmp/openclaw.json"],
      command: "open",
    });
  });

  it("uses xdg-open on Linux", () => {
    expect(resolveConfigOpenCommand("/tmp/openclaw.json", "linux")).toEqual({
      args: ["/tmp/openclaw.json"],
      command: "xdg-open",
    });
  });

  it("uses a quoted PowerShell literal on Windows", () => {
    expect(resolveConfigOpenCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -LiteralPath 'C:\tmp\o''hai & calc.json'`,
      ],
      command: "powershell.exe",
    });
  });
});

describe("config.openFile", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    vi.clearAllMocks();
  });

  it("opens the configured file without shell interpolation", async () => {
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/config $(touch pwned).json";
    execFileMock.mockImplementation((...args: unknown[]) => {
      expect(["open", "xdg-open", "powershell.exe"]).toContain(args[0]);
      expect(args[1]).toEqual(["/tmp/config $(touch pwned).json"]);
      invokeExecFileCallback(args, null);
      return {} as never;
    });

    const { options, respond } = createConfigHandlerHarness({ method: "config.openFile" });
    await configHandlers["config.openFile"](options);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        path: "/tmp/config $(touch pwned).json",
      },
      undefined,
    );
  });

  it("returns a generic error and logs details when the opener fails", async () => {
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/config.json";
    execFileMock.mockImplementation((...args: unknown[]) => {
      invokeExecFileCallback(
        args,
        Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }),
      );
      return {} as never;
    });

    const { options, respond, logGateway } = createConfigHandlerHarness({
      method: "config.openFile",
    });
    await configHandlers["config.openFile"](options);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        error: "failed to open config file",
        ok: false,
        path: "/tmp/config.json",
      },
      undefined,
    );
    expect(logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("spawn xdg-open ENOENT"));
  });
});
