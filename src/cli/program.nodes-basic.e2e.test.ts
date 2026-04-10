import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesCli } from "./nodes-cli.js";
import { createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { callGateway, installBaseProgramMocks, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();

function formatRuntimeLogCallArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

describe("cli program (nodes basics)", () => {
  let program: Command;

  function createProgram() {
    const next = new Command();
    next.exitOverride();
    registerNodesCli(next);
    return next;
  }

  async function runProgram(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  function getRuntimeOutput() {
    return runtime.log.mock.calls.map((c) => formatRuntimeLogCallArg(c[0])).join("\n");
  }

  function mockGatewayWithIosNodeListAnd(method: "node.describe" | "node.invoke", result: unknown) {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.list") {
        return createIosNodeListResponse();
      }
      if (opts.method === method) {
        return result;
      }
      return { ok: true };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    program = createProgram();
  });

  it("runs nodes list --connected and filters to connected nodes", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          paired: [
            {
              displayName: "One",
              lastConnectedAtMs: now - 1_000,
              nodeId: "n1",
              remoteIp: "10.0.0.1",
            },
            {
              displayName: "Two",
              lastConnectedAtMs: now - 1_000,
              nodeId: "n2",
              remoteIp: "10.0.0.2",
            },
          ],
          pending: [],
        };
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            { connected: true, nodeId: "n1" },
            { connected: false, nodeId: "n2" },
          ],
        };
      }
      return { ok: true };
    });
    await runProgram(["nodes", "list", "--connected"]);

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.list" }));
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it("runs nodes status --last-connected and filters by age", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.list") {
        return {
          nodes: [
            { connected: false, displayName: "One", nodeId: "n1" },
            { connected: false, displayName: "Two", nodeId: "n2" },
          ],
          ts: now,
        };
      }
      if (opts.method === "node.pair.list") {
        return {
          paired: [
            { lastConnectedAtMs: now - 1_000, nodeId: "n1" },
            { lastConnectedAtMs: now - 2 * 24 * 60 * 60 * 1000, nodeId: "n2" },
          ],
          pending: [],
        };
      }
      return { ok: true };
    });
    await runProgram(["nodes", "status", "--last-connected", "24h"]);

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.pair.list" }));
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it.each([
    {
      expectedOutput: [
        "Known: 1 · Paired: 1 · Connected: 1",
        "iOS Node",
        "Detail",
        "device: iPad",
        "hw: iPad16,6",
        "Status",
        "paired",
        "Caps",
        "camera",
        "canvas",
      ],
      label: "paired node details",
      node: {
        caps: ["canvas", "camera"],
        connected: true,
        deviceFamily: "iPad",
        displayName: "iOS Node",
        modelIdentifier: "iPad16,6",
        nodeId: "ios-node",
        paired: true,
        remoteIp: "192.168.0.88",
      },
    },
    {
      expectedOutput: [
        "Known: 1 · Paired: 0 · Connected: 1",
        "Peter's Tab",
        "S10 Ultra",
        "Detail",
        "device: Android",
        "hw: samsung",
        "SM-X926B",
        "Status",
        "unpaired",
        "connected",
        "Caps",
        "camera",
        "canvas",
      ],
      label: "unpaired node details",
      node: {
        caps: ["canvas", "camera"],
        connected: true,
        deviceFamily: "Android",
        displayName: "Peter's Tab S10 Ultra",
        modelIdentifier: "samsung SM-X926B",
        nodeId: "android-node",
        paired: false,
        remoteIp: "192.168.0.99",
      },
    },
  ])("runs nodes status and renders $label", async ({ node, expectedOutput }) => {
    callGateway.mockResolvedValue({
      nodes: [node],
      ts: Date.now(),
    });
    await runProgram(["nodes", "status"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );

    const output = getRuntimeOutput();
    for (const expected of expectedOutput) {
      expect(output).toContain(expected);
    }
  });

  it("runs nodes describe and calls node.describe", async () => {
    mockGatewayWithIosNodeListAnd("node.describe", {
      caps: ["canvas", "camera"],
      commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
      connected: true,
      displayName: "iOS Node",
      nodeId: "ios-node",
      ts: Date.now(),
    });

    await runProgram(["nodes", "describe", "--node", "ios-node"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.describe",
        params: { nodeId: "ios-node" },
      }),
    );

    const out = getRuntimeOutput();
    expect(out).toContain("Commands");
    expect(out).toContain("canvas.eval");
  });

  it("runs nodes approve and calls node.pair.approve", async () => {
    callGateway.mockResolvedValue({
      node: { nodeId: "n1", token: "t1" },
      requestId: "r1",
    });
    await expect(runProgram(["nodes", "approve", "r1"])).rejects.toThrow("exit");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
        params: { requestId: "r1" },
      }),
    );
  });

  it("runs nodes invoke and calls node.invoke", async () => {
    mockGatewayWithIosNodeListAnd("node.invoke", {
      command: "canvas.eval",
      nodeId: "ios-node",
      ok: true,
      payload: { result: "ok" },
    });

    await expect(
      runProgram([
        "nodes",
        "invoke",
        "--node",
        "ios-node",
        "--command",
        "canvas.eval",
        "--params",
        '{"javaScript":"1+1"}',
      ]),
    ).rejects.toThrow("exit");

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: {
          command: "canvas.eval",
          idempotencyKey: "idem-test",
          nodeId: "ios-node",
          params: { javaScript: "1+1" },
          timeoutMs: 15_000,
        },
      }),
    );
  });
});
