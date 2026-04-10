import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import type { OpenClawPluginApi } from "./api.js";

let runtimeStub: {
  config: { toNumber?: string };
  manager: {
    initiateCall: ReturnType<typeof vi.fn>;
    continueCall: ReturnType<typeof vi.fn>;
    speak: ReturnType<typeof vi.fn>;
    endCall: ReturnType<typeof vi.fn>;
    getCall: ReturnType<typeof vi.fn>;
    getCallByProviderCallId: ReturnType<typeof vi.fn>;
  };
  stop: ReturnType<typeof vi.fn>;
};

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

interface Registered {
  methods: Map<string, unknown>;
  tools: unknown[];
}
type RegisterVoiceCall = (api: Record<string, unknown>) => void | Promise<void>;
interface RegisterCliContext {
  program: Command;
  config: Record<string, unknown>;
  workspaceDir?: string;
  logger: typeof noopLogger;
}

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}
function setup(config: Record<string, unknown>): Registered {
  const methods = new Map<string, unknown>();
  const tools: unknown[] = [];
  const api = createTestPluginApi({
    config: {},
    description: "test",
    id: "voice-call",
    logger: noopLogger,
    name: "Voice Call",
    pluginConfig: config,
    registerCli: () => {},
    registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
    registerService: () => {},
    registerTool: (tool: unknown) => tools.push(tool),
    resolvePath: (p: string) => p,
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    source: "test",
    version: "0",
  });
  void plugin.register(api);
  return { methods, tools };
}

async function registerVoiceCallCli(program: Command) {
  const { register } = plugin as unknown as {
    register: RegisterVoiceCall;
  };
  await register({
    config: {},
    description: "test",
    id: "voice-call",
    logger: noopLogger,
    name: "Voice Call",
    pluginConfig: { provider: "mock" },
    registerCli: (fn: (ctx: RegisterCliContext) => void) =>
      fn({
        config: {},
        logger: noopLogger,
        program,
        workspaceDir: undefined,
      }),
    registerGatewayMethod: () => {},
    registerService: () => {},
    registerTool: () => {},
    resolvePath: (p: string) => p,
    runtime: { tts: { textToSpeechTelephony: vi.fn() } },
    source: "test",
    version: "0",
  });
}

describe("voice-call plugin", () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
    noopLogger.debug.mockClear();
    vi.mocked(createVoiceCallRuntime).mockClear();
    runtimeStub = {
      config: { toNumber: "+15550001234" },
      manager: {
        continueCall: vi.fn(async () => ({
          success: true,
          transcript: "hello",
        })),
        endCall: vi.fn(async () => ({ success: true })),
        getCall: vi.fn((id: string) => (id === "call-1" ? { callId: "call-1" } : undefined)),
        getCallByProviderCallId: vi.fn(() => undefined),
        initiateCall: vi.fn(async () => ({ callId: "call-1", success: true })),
        speak: vi.fn(async () => ({ success: true })),
      },
      stop: vi.fn(async () => {}),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  it("initiates a call via voicecall.initiate", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.initiate") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { message: "Hi" }, respond });
    expect(runtimeStub.manager.initiateCall).toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.callId).toBe("call-1");
  });

  it("returns call status", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.status") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { callId: "call-1" }, respond });
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.found).toBe(true);
  });

  it("normalizes legacy config through runtime creation and warns to run doctor", async () => {
    const { methods } = setup({
      enabled: true,
      provider: "log",
      streaming: {
        enabled: true,
        openaiApiKey: "sk-test",
        sttProvider: "openai", // Pragma: allowlist secret
      },
      twilio: {
        from: "+15550001234",
      },
    });
    const handler = methods.get("voicecall.status") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { callId: "call-1" }, respond });

    expect(vi.mocked(createVoiceCallRuntime)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createVoiceCallRuntime).mock.calls[0]?.[0]?.config).toMatchObject({
      enabled: true,
      fromNumber: "+15550001234",
      provider: "mock",
      streaming: {
        enabled: true,
        provider: "openai",
        providers: {
          openai: {
            apiKey: "sk-test",
          },
        },
      },
    });
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Run "openclaw doctor --fix"'),
    );
  });

  it("tool get_status returns json payload", async () => {
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", {
      action: "get_status",
      callId: "call-1",
    })) as { details: { found?: boolean } };
    expect(result.details.found).toBe(true);
  });

  it("legacy tool status without sid returns error payload", async () => {
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", { mode: "status" })) as {
      details: { error?: unknown };
    };
    expect(String(result.details.error)).toContain("sid required");
  });

  it("CLI latency summarizes turn metrics from JSONL", async () => {
    const program = new Command();
    const tmpFile = path.join(os.tmpdir(), `voicecall-latency-${Date.now()}.jsonl`);
    fs.writeFileSync(
      tmpFile,
      [
        JSON.stringify({ metadata: { lastTurnLatencyMs: 100, lastTurnListenWaitMs: 70 } }),
        JSON.stringify({ metadata: { lastTurnLatencyMs: 200, lastTurnListenWaitMs: 110 } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const stdout = captureStdout();

    try {
      await registerVoiceCallCli(program);

      await program.parseAsync(["voicecall", "latency", "--file", tmpFile, "--last", "10"], {
        from: "user",
      });

      const printed = stdout.output();
      expect(printed).toContain('"recordsScanned": 2');
      expect(printed).toContain('"p50Ms": 100');
      expect(printed).toContain('"p95Ms": 200');
    } finally {
      stdout.restore();
      fs.unlinkSync(tmpFile);
    }
  });

  it("CLI start prints JSON", async () => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program);

    try {
      await program.parseAsync(["voicecall", "start", "--to", "+1", "--message", "Hello"], {
        from: "user",
      });
      expect(stdout.output()).toContain('"callId": "call-1"');
    } finally {
      stdout.restore();
    }
  });
});
