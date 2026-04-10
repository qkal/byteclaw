import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const WRITE_SCOPE_HEADER = { "x-openclaw-scopes": "operator.write" };

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let createEmbeddingProviderMock: ReturnType<
  typeof vi.fn<
    (options: { provider: string; model: string; agentDir?: string }) => Promise<{
      provider: {
        id: string;
        model: string;
        embedQuery: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
      };
    }>
  >
>;
let clearMemoryEmbeddingProviders: typeof import("../plugins/memory-embedding-providers.js").clearMemoryEmbeddingProviders;
let registerMemoryEmbeddingProvider: typeof import("../plugins/memory-embedding-providers.js").registerMemoryEmbeddingProvider;
let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ clearMemoryEmbeddingProviders, registerMemoryEmbeddingProvider } =
    await import("../plugins/memory-embedding-providers.js"));
  createEmbeddingProviderMock = vi.fn(
    async (options: { provider: string; model: string; agentDir?: string }) => ({
      provider: {
        embedBatch: async (texts: string[]) =>
          texts.map((_text, index) => [index + 0.1, index + 0.2]),
        embedQuery: async () => [0.1, 0.2],
        id: options.provider,
        model: options.model,
      },
    }),
  );
  clearMemoryEmbeddingProviders();
  const openAiAdapter: MemoryEmbeddingProviderAdapter = {
    allowExplicitWhenConfiguredAuto: true,
    autoSelectPriority: 20,
    create: async (options) => {
      const result = await createEmbeddingProviderMock({
        agentDir: options.agentDir,
        model: options.model,
        provider: "openai",
      });
      return result;
    },
    defaultModel: "text-embedding-3-small",
    id: "openai",
    transport: "remote",
  };
  registerMemoryEmbeddingProvider(openAiAdapter);
  ({ startGatewayServer } = await import("./server.js"));
  enabledPort = await getFreePort();
  enabledServer = await startServer(enabledPort, { openAiChatCompletionsEnabled: true });
});

afterAll(async () => {
  await enabledServer.close({ reason: "embeddings http enabled suite done" });
  clearMemoryEmbeddingProviders();
  vi.resetModules();
});

async function startServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  return await startGatewayServer(port, {
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    host: "127.0.0.1",
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? false,
  });
}

async function postEmbeddings(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...WRITE_SCOPE_HEADER,
      ...headers,
    },
    method: "POST",
  });
}

describe("OpenAI-compatible embeddings HTTP API (e2e)", () => {
  it("embeds string and array inputs", async () => {
    const single = await postEmbeddings({
      input: "hello",
      model: "openclaw/default",
    });
    expect(single.status).toBe(200);
    const singleJson = (await single.json()) as {
      object?: string;
      data?: { object?: string; embedding?: number[]; index?: number }[];
    };
    expect(singleJson.object).toBe("list");
    expect(singleJson.data?.[0]?.object).toBe("embedding");
    expect(singleJson.data?.[0]?.embedding).toEqual([0.1, 0.2]);

    const batch = await postEmbeddings({
      input: ["a", "b"],
      model: "openclaw/default",
    });
    expect(batch.status).toBe(200);
    const batchJson = (await batch.json()) as {
      data?: { embedding?: number[]; index?: number }[];
    };
    expect(batchJson.data).toEqual([
      { embedding: [0.1, 0.2], index: 0, object: "embedding" },
      { embedding: [1.1, 1.2], index: 1, object: "embedding" },
    ]);

    const qualified = await postEmbeddings(
      {
        input: "hello again",
        model: "openclaw/default",
      },
      { "x-openclaw-model": "openai/text-embedding-3-small" },
    );
    expect(qualified.status).toBe(200);
    const qualifiedJson = (await qualified.json()) as { model?: string };
    expect(qualifiedJson.model).toBe("openclaw/default");
    const lastCall = createEmbeddingProviderMock.mock.calls.at(-1)?.[0] as
      | { provider?: string; model?: string }
      | undefined;
    expect(lastCall).toMatchObject({
      model: "text-embedding-3-small",
      provider: "openai",
    });
  });

  it("supports base64 encoding and agent-scoped auth/config resolution", async () => {
    const res = await postEmbeddings(
      {
        encoding_format: "base64",
        input: "hello",
        model: "openclaw/beta",
      },
      { "x-openclaw-agent-id": "beta" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: { embedding?: string }[] };
    expect(typeof json.data?.[0]?.embedding).toBe("string");
    expect(createEmbeddingProviderMock).toHaveBeenCalled();
    const lastCall = createEmbeddingProviderMock.mock.calls.at(-1)?.[0] as
      | { provider?: string; model?: string; agentDir?: string }
      | undefined;
    expect(typeof lastCall?.model).toBe("string");
    expect(lastCall?.agentDir).toBe(resolveAgentDir({}, "beta"));
  });

  it("rejects invalid input shapes", async () => {
    const res = await postEmbeddings({
      input: [{ nope: true }],
      model: "openclaw/default",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
  });

  it("ignores narrower declared scopes for shared-secret bearer auth", async () => {
    const res = await postEmbeddings(
      {
        input: "hello",
        model: "openclaw/default",
      },
      { "x-openclaw-scopes": "operator.read" },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ embedding: [0.1, 0.2], object: "embedding" }],
      object: "list",
    });
  });

  it("allows requests with an empty declared scopes header", async () => {
    const res = await postEmbeddings(
      {
        input: "hello",
        model: "openclaw/default",
      },
      { "x-openclaw-scopes": "" },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ embedding: [0.1, 0.2], object: "embedding" }],
      object: "list",
    });
  });

  it("allows requests when the operator scopes header is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
      body: JSON.stringify({
        input: "hello",
        model: "openclaw/default",
      }),
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ embedding: [0.1, 0.2], object: "embedding" }],
      object: "list",
    });
  });

  it("rejects invalid agent targets", async () => {
    const res = await postEmbeddings({
      input: "hello",
      model: "ollama/nomic-embed-text",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      message: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
      type: "invalid_request_error",
    });
  });

  it("rejects disallowed x-openclaw-model provider overrides", async () => {
    const res = await postEmbeddings(
      {
        input: "hello",
        model: "openclaw/default",
      },
      { "x-openclaw-model": "ollama/nomic-embed-text" },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      message: "This agent does not allow that embedding provider on `/v1/embeddings`.",
      type: "invalid_request_error",
    });
  });

  it("rejects oversized batches", async () => {
    const res = await postEmbeddings({
      input: Array.from({ length: 129 }, () => "x"),
      model: "openclaw/default",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      message: "Too many inputs (max 128).",
      type: "invalid_request_error",
    });
  });

  it("sanitizes provider failures", async () => {
    createEmbeddingProviderMock.mockRejectedValueOnce(new Error("secret upstream failure"));
    const res = await postEmbeddings({
      input: "hello",
      model: "openclaw/default",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      message: "internal error",
      type: "api_error",
    });
  });
});
