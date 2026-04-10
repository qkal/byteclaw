import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesCli } from "./nodes-cli.js";

interface NodeInvokeCall {
  method?: string;
  params?: {
    idempotencyKey?: string;
    command?: string;
    params?: unknown;
    timeoutMs?: number;
  };
}

let lastNodeInvokeCall: NodeInvokeCall | null = null;

const callGateway = vi.fn(async (opts: NodeInvokeCall) => {
  if (opts.method === "node.list") {
    return {
      nodes: [
        {
          caps: ["canvas"],
          connected: true,
          displayName: "Mac",
          nodeId: "mac-1",
          permissions: { screenRecording: true },
          platform: "macos",
        },
      ],
    };
  }
  if (opts.method === "node.invoke") {
    lastNodeInvokeCall = opts;
    return {
      payload: {
        exitCode: 0,
        stderr: "",
        stdout: "",
        success: true,
        timedOut: false,
      },
    };
  }
  return { ok: true };
});

const randomIdempotencyKey = vi.fn(() => "rk_test");

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
  };
  return {
    defaultRuntime,
    runtimeErrors,
  };
});

const { runtimeErrors, defaultRuntime } = mocks;

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts as NodeInvokeCall),
  randomIdempotencyKey: () => randomIdempotencyKey(),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

describe("nodes-cli coverage", () => {
  const sharedProgram: Command = new Command();

  const withSuppressedStderr = async <T>(run: () => Promise<T>) => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      return await run();
    } finally {
      stderrSpy.mockRestore();
    }
  };

  const getNodeInvokeCall = () => {
    const last = lastNodeInvokeCall;
    if (!last) {
      throw new Error("expected node.invoke call");
    }
    return last;
  };

  const runNodesCommand = async (args: string[]) => {
    await sharedProgram.parseAsync(args, { from: "user" });
    return getNodeInvokeCall();
  };

  if (sharedProgram.commands.length === 0) {
    sharedProgram.exitOverride();
    registerNodesCli(sharedProgram);
  }

  beforeEach(() => {
    runtimeErrors.length = 0;
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
    lastNodeInvokeCall = null;
  });

  it("does not register the removed run wrapper", async () => {
    await withSuppressedStderr(async () => {
      await expect(
        sharedProgram.parseAsync(["nodes", "run", "--node", "mac-1"], { from: "user" }),
      ).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
    });
  });

  it("blocks system.run on nodes invoke", async () => {
    await expect(
      sharedProgram.parseAsync(["nodes", "invoke", "--node", "mac-1", "--command", "system.run"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain('command "system.run" is reserved for shell execution');
  });

  it("invokes system.notify with provided fields", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "notify",
      "--node",
      "mac-1",
      "--title",
      "Ping",
      "--body",
      "Gateway ready",
      "--delivery",
      "overlay",
    ]);

    expect(invoke).toBeTruthy();
    expect(invoke?.params?.command).toBe("system.notify");
    expect(invoke?.params?.params).toEqual({
      body: "Gateway ready",
      delivery: "overlay",
      priority: undefined,
      sound: undefined,
      title: "Ping",
    });
  });

  it("invokes location.get with params", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "location",
      "get",
      "--node",
      "mac-1",
      "--accuracy",
      "precise",
      "--max-age",
      "1000",
      "--location-timeout",
      "5000",
      "--invoke-timeout",
      "6000",
    ]);

    expect(invoke).toBeTruthy();
    expect(invoke?.params?.command).toBe("location.get");
    expect(invoke?.params?.params).toEqual({
      desiredAccuracy: "precise",
      maxAgeMs: 1000,
      timeoutMs: 5000,
    });
    expect(invoke?.params?.timeoutMs).toBe(6000);
  });
});
