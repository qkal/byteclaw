import * as fs from "node:fs/promises";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IOS_NODE, createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { callGateway, installBaseProgramMocks, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();
let registerNodesCli: (program: Command) => void;

function getFirstRuntimeLogLine(): string {
  const first = runtime.log.mock.calls[0]?.[0];
  if (typeof first !== "string") {
    throw new Error(`Expected runtime.log first arg to be string, got ${typeof first}`);
  }
  return first;
}

async function expectLoggedSingleMediaFile(params?: {
  expectedContent?: string;
  expectedPathPattern?: RegExp;
}): Promise<string> {
  const out = getFirstRuntimeLogLine();
  const mediaPath = out.replace(/^MEDIA:/, "").trim();
  if (params?.expectedPathPattern) {
    expect(mediaPath).toMatch(params.expectedPathPattern);
  }
  try {
    await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe(params?.expectedContent ?? "hi");
  } finally {
    await fs.unlink(mediaPath).catch(() => {});
  }
  return mediaPath;
}

function mockNodeGateway(command?: string, payload?: Record<string, unknown>) {
  callGateway.mockImplementation(async (...args: unknown[]) => {
    const opts = (args[0] ?? {}) as { method?: string };
    if (opts.method === "node.list") {
      return createIosNodeListResponse();
    }
    if (opts.method === "node.invoke" && command) {
      return {
        command,
        nodeId: IOS_NODE.nodeId,
        ok: true,
        payload,
      };
    }
    return { ok: true };
  });
}

describe("cli program (nodes media)", () => {
  let program: Command;

  beforeAll(async () => {
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = new Command();
    program.exitOverride();
    registerNodesCli(program);
  });

  async function runNodesCommand(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  async function expectCameraSnapParseFailure(args: string[], expectedError: RegExp) {
    mockNodeGateway();

    const parseProgram = new Command();
    parseProgram.exitOverride();
    registerNodesCli(parseProgram);
    runtime.error.mockClear();

    await expect(parseProgram.parseAsync(args, { from: "user" })).rejects.toThrow(/exit/i);
    expect(runtime.error.mock.calls.some(([msg]) => expectedError.test(String(msg)))).toBe(true);
  }

  async function runAndExpectUrlPayloadMediaFile(params: {
    command: "camera.snap" | "camera.clip";
    payload: Record<string, unknown>;
    argv: string[];
    expectedPathPattern: RegExp;
  }) {
    mockNodeGateway(params.command, params.payload);
    await runNodesCommand(params.argv);
    await expectLoggedSingleMediaFile({
      expectedContent: "url-content",
      expectedPathPattern: params.expectedPathPattern,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs nodes camera snap and prints two MEDIA paths", async () => {
    mockNodeGateway("camera.snap", { base64: "aGk=", format: "jpg", height: 1, width: 1 });

    await runNodesCommand(["nodes", "camera", "snap", "--node", "ios-node"]);

    const invokeCalls = callGateway.mock.calls
      .map((call) => call[0] as { method?: string; params?: Record<string, unknown> })
      .filter((call) => call.method === "node.invoke");
    const facings = invokeCalls
      .map((call) => (call.params?.params as { facing?: string } | undefined)?.facing)
      .filter((facing): facing is string => Boolean(facing))
      .toSorted((a, b) => a.localeCompare(b));
    expect(facings).toEqual(["back", "front"]);

    const out = getFirstRuntimeLogLine();
    const mediaPaths = out
      .split("\n")
      .filter((l) => l.startsWith("MEDIA:"))
      .map((l) => l.replace(/^MEDIA:/, ""))
      .filter(Boolean);
    expect(mediaPaths).toHaveLength(2);
    expect(mediaPaths[0]).toContain("openclaw-camera-snap-");
    expect(mediaPaths[1]).toContain("openclaw-camera-snap-");

    try {
      // Content bytes are covered by single-output camera/file tests; here we
      // Only verify dual snapshot behavior and that both paths were written.
      await expect(fs.stat(mediaPaths[0])).resolves.toBeTruthy();
      await expect(fs.stat(mediaPaths[1])).resolves.toBeTruthy();
    } finally {
      await Promise.all(mediaPaths.map((p) => fs.unlink(p).catch(() => {})));
    }
  });

  it("runs nodes camera clip and prints one MEDIA path", async () => {
    mockNodeGateway("camera.clip", {
      base64: "aGk=",
      durationMs: 3000,
      format: "mp4",
      hasAudio: true,
    });

    await runNodesCommand(["nodes", "camera", "clip", "--node", "ios-node", "--duration", "3000"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          command: "camera.clip",
          idempotencyKey: "idem-test",
          nodeId: "ios-node",
          params: expect.objectContaining({
            durationMs: 3000,
            facing: "front",
            format: "mp4",
            includeAudio: true,
          }),
          timeoutMs: 90_000,
        }),
      }),
    );

    await expectLoggedSingleMediaFile({
      expectedPathPattern: /openclaw-camera-clip-front-.*\.mp4$/,
    });
  });

  it("runs nodes camera snap with facing front and passes params", async () => {
    mockNodeGateway("camera.snap", { base64: "aGk=", format: "jpg", height: 1, width: 1 });

    await runNodesCommand([
      "nodes",
      "camera",
      "snap",
      "--node",
      "ios-node",
      "--facing",
      "front",
      "--max-width",
      "640",
      "--quality",
      "0.8",
      "--delay-ms",
      "2000",
      "--device-id",
      "cam-123",
    ]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          command: "camera.snap",
          idempotencyKey: "idem-test",
          nodeId: "ios-node",
          params: expect.objectContaining({
            delayMs: 2000,
            deviceId: "cam-123",
            facing: "front",
            maxWidth: 640,
            quality: 0.8,
          }),
          timeoutMs: 20_000,
        }),
      }),
    );

    await expectLoggedSingleMediaFile();
  });

  it("runs nodes camera clip with --no-audio", async () => {
    mockNodeGateway("camera.clip", {
      base64: "aGk=",
      durationMs: 3000,
      format: "mp4",
      hasAudio: false,
    });

    await runNodesCommand([
      "nodes",
      "camera",
      "clip",
      "--node",
      "ios-node",
      "--duration",
      "3000",
      "--no-audio",
      "--device-id",
      "cam-123",
    ]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          command: "camera.clip",
          idempotencyKey: "idem-test",
          nodeId: "ios-node",
          params: expect.objectContaining({
            deviceId: "cam-123",
            includeAudio: false,
          }),
          timeoutMs: 90_000,
        }),
      }),
    );

    await expectLoggedSingleMediaFile();
  });

  it("runs nodes camera clip with human duration (10s)", async () => {
    mockNodeGateway("camera.clip", {
      base64: "aGk=",
      durationMs: 10_000,
      format: "mp4",
      hasAudio: true,
    });

    await runNodesCommand(["nodes", "camera", "clip", "--node", "ios-node", "--duration", "10s"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          command: "camera.clip",
          nodeId: "ios-node",
          params: expect.objectContaining({ durationMs: 10_000 }),
        }),
      }),
    );
  });

  it("runs nodes canvas snapshot and prints MEDIA path", async () => {
    mockNodeGateway("canvas.snapshot", { base64: "aGk=", format: "png" });

    await runNodesCommand(["nodes", "canvas", "snapshot", "--node", "ios-node", "--format", "png"]);

    await expectLoggedSingleMediaFile({
      expectedPathPattern: /openclaw-canvas-snapshot-.*\.png$/,
    });
  });

  it("fails nodes camera snap on invalid facing", async () => {
    await expectCameraSnapParseFailure(
      ["nodes", "camera", "snap", "--node", "ios-node", "--facing", "nope"],
      /invalid facing/i,
    );
  });

  it("fails nodes camera snap when --facing both and --device-id are combined", async () => {
    await expectCameraSnapParseFailure(
      [
        "nodes",
        "camera",
        "snap",
        "--node",
        "ios-node",
        "--facing",
        "both",
        "--device-id",
        "cam-123",
      ],
      /facing=both is not allowed when --device-id is set/i,
    );
  });

  describe("URL-based payloads", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeAll(() => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async () =>
          new Response("url-content", {
            headers: { "content-length": String("11") },
            status: 200,
          }),
      ) as unknown as typeof globalThis.fetch;
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    it.each([
      {
        argv: ["nodes", "camera", "snap", "--node", "ios-node", "--facing", "front"],
        command: "camera.snap" as const,
        expectedPathPattern: /openclaw-camera-snap-front-.*\.jpg$/,
        label: "runs nodes camera snap with url payload",
        payload: {
          format: "jpg",
          height: 480,
          url: `https://${IOS_NODE.remoteIp}/photo.jpg`,
          width: 640,
        },
      },
      {
        argv: ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "5000"],
        command: "camera.clip" as const,
        expectedPathPattern: /openclaw-camera-clip-front-.*\.mp4$/,
        label: "runs nodes camera clip with url payload",
        payload: {
          durationMs: 5000,
          format: "mp4",
          hasAudio: true,
          url: `https://${IOS_NODE.remoteIp}/clip.mp4`,
        },
      },
    ])("$label", async ({ command, payload, argv, expectedPathPattern }) => {
      await runAndExpectUrlPayloadMediaFile({
        argv,
        command,
        expectedPathPattern,
        payload,
      });
    });
  });
});
