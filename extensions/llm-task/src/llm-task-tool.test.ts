import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sinclair/typebox", () => ({
  Type: {
    Number: (schema?: unknown) => schema,
    Object: (schema: unknown) => schema,
    Optional: (schema: unknown) => schema,
    String: (schema?: unknown) => schema,
    Unknown: (schema?: unknown) => schema,
  },
}));

vi.mock("ajv", () => ({
  default: class MockAjv {
    compile(schema: unknown) {
      return (value: unknown) => {
        if (
          schema &&
          typeof schema === "object" &&
          !Array.isArray(schema) &&
          (schema as { properties?: Record<string, { type?: string }> }).properties?.foo?.type ===
            "string"
        ) {
          const ok = typeof (value as { foo?: unknown })?.foo === "string";
          (this as { errors?: { instancePath: string; message: string }[] }).errors = ok
            ? undefined
            : [{ instancePath: "/foo", message: "must be string" }];
          return ok;
        }
        (this as { errors?: { instancePath: string; message: string }[] }).errors = undefined;
        return true;
      };
    }

    errors?: { instancePath: string; message: string }[];
  },
}));

vi.mock("../api.js", async () => {
  const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () => "/tmp",
    supportsXHighThinking: () => false,
  };
});

import { createLlmTaskTool } from "./llm-task-tool.js";

const runEmbeddedPiAgent = vi.fn(async () => ({
  meta: { startedAt: Date.now() },
  payloads: [{ text: "{}" }],
}));

function fakeApi(overrides: any = {}) {
  return {
    config: {
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.2" }, workspace: "/tmp" } },
    },
    id: "llm-task",
    logger: { debug() {}, error() {}, info() {}, warn() {} },
    name: "llm-task",
    pluginConfig: {},
    registerTool() {},
    runtime: {
      agent: {
        runEmbeddedPiAgent,
      },
      version: "test",
    },
    source: "test",
    ...overrides,
  };
}

function mockEmbeddedRunJson(payload: unknown) {
  (runEmbeddedPiAgent as any).mockResolvedValueOnce({
    meta: {},
    payloads: [{ text: JSON.stringify(payload) }],
  });
}

async function executeEmbeddedRun(input: Record<string, unknown>) {
  const tool = createLlmTaskTool(fakeApi());
  await tool.execute("id", input);
  return (runEmbeddedPiAgent as any).mock.calls[0]?.[0];
}

describe("llm-task tool (json-only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns parsed json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return foo" });
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("strips fenced json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: '```json\n{"ok":true}\n```' }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const res = await tool.execute("id", { prompt: "return ok" });
    expect((res as any).details.json).toEqual({ ok: true });
  });

  it("validates schema", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: "bar" }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const schema = {
      additionalProperties: false,
      properties: { foo: { type: "string" } },
      required: ["foo"],
      type: "object",
    };
    const res = await tool.execute("id", { prompt: "return foo", schema });
    expect((res as any).details.json).toEqual({ foo: "bar" });
  });

  it("throws on invalid json", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "not-json" }],
    });
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x" })).rejects.toThrow(/invalid json/i);
  });

  it("throws on schema mismatch", async () => {
    (runEmbeddedPiAgent as any).mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: JSON.stringify({ foo: 1 }) }],
    });
    const tool = createLlmTaskTool(fakeApi());
    const schema = { properties: { foo: { type: "string" } }, required: ["foo"], type: "object" };
    await expect(tool.execute("id", { prompt: "x", schema })).rejects.toThrow(/match schema/i);
  });

  it("passes provider/model overrides to embedded runner", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({
      model: "claude-4-sonnet",
      prompt: "x",
      provider: "anthropic",
    });
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-4-sonnet");
  });

  it("passes thinking override to embedded runner", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x", thinking: "high" });
    expect(call.thinkLevel).toBe("high");
  });

  it("normalizes thinking aliases", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x", thinking: "on" });
    expect(call.thinkLevel).toBe("low");
  });

  it("throws on invalid thinking level", async () => {
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x", thinking: "banana" })).rejects.toThrow(
      /invalid thinking level/i,
    );
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("throws on unsupported xhigh thinking level", async () => {
    const tool = createLlmTaskTool(fakeApi());
    await expect(tool.execute("id", { prompt: "x", thinking: "xhigh" })).rejects.toThrow(
      /only supported/i,
    );
  });

  it("does not pass thinkLevel when thinking is omitted", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x" });
    expect(call.thinkLevel).toBeUndefined();
  });

  it("enforces allowedModels", async () => {
    mockEmbeddedRunJson({ ok: true });
    const tool = createLlmTaskTool(
      fakeApi({ pluginConfig: { allowedModels: ["openai-codex/gpt-5.2"] } }),
    );
    await expect(
      tool.execute("id", { model: "claude-4-sonnet", prompt: "x", provider: "anthropic" }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("disables tools for embedded run", async () => {
    mockEmbeddedRunJson({ ok: true });
    const call = await executeEmbeddedRun({ prompt: "x" });
    expect(call.disableTools).toBe(true);
  });
});
