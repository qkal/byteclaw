import crypto from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { prepareGooglePromptCacheStreamFn } from "./google-prompt-cache.js";

interface SessionCustomEntry {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data: unknown;
}

function makeSessionManager(entries: SessionCustomEntry[] = []) {
  let counter = 0;
  return {
    appendCustomEntry(customType: string, data: unknown) {
      counter += 1;
      const id = `entry-${counter}`;
      entries.push({
        customType,
        data,
        id,
        parentId: null,
        timestamp: new Date(counter * 1000).toISOString(),
        type: "custom",
      });
      return id;
    },
    getEntries() {
      return entries;
    },
  };
}

function makeGoogleModel(id = "gemini-3.1-pro-preview") {
  return {
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    headers: { "X-Provider": "google" },
    id,
    input: ["text"],
    maxTokens: 8192,
    name: id,
    provider: "google",
    reasoning: false,
  } satisfies Model<"google-generative-ai">;
}

function createCacheFetchMock(params: { name: string; expireTime: string }) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(params), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
}

function createCapturingStreamFn(result = "stream") {
  let capturedPayload: Record<string, unknown> | undefined;
  const streamFn = vi.fn(
    (
      model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      const payload: Record<string, unknown> = {};
      void options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return result as never;
    },
  );
  return {
    getCapturedPayload: () => capturedPayload,
    streamFn,
  };
}

function preparePromptCacheStream(params: {
  fetchMock: ReturnType<typeof vi.fn>;
  now: number;
  sessionManager: ReturnType<typeof makeSessionManager>;
  streamFn: StreamFn;
}) {
  return prepareGooglePromptCacheStreamFn(
    {
      apiKey: "gemini-api-key",
      extraParams: { cacheRetention: "long" },
      model: makeGoogleModel(),
      modelId: "gemini-3.1-pro-preview",
      provider: "google",
      sessionManager: params.sessionManager,
      streamFn: params.streamFn,
      systemPrompt: "Follow policy.",
    },
    {
      buildGuardedFetch: () => params.fetchMock as typeof fetch,
      now: () => params.now,
    },
  );
}

describe("google prompt cache", () => {
  it("creates cached content from the system prompt and strips that prompt from live requests", async () => {
    const now = 1_000_000;
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const fetchMock = createCacheFetchMock({
      expireTime: new Date(now + 3_600_000).toISOString(),
      name: "cachedContents/system-cache-1",
    });
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    expect(wrapped).toBeTypeOf("function");
    void wrapped?.(
      makeGoogleModel(),
      {
        messages: [],
        systemPrompt: "Follow policy.",
        tools: [
          {
            description: "Look up a value",
            name: "lookup",
            parameters: { type: "object" },
          },
        ],
      } as never,
      { temperature: 0.2 } as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Provider": "google",
          "x-goog-api-key": "gemini-api-key",
        }),
        method: "POST",
      }),
    );
    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(createBody).toEqual({
      model: "models/gemini-3.1-pro-preview",
      systemInstruction: {
        parts: [{ text: "Follow policy." }],
      },
      ttl: "3600s",
    });
    expect(innerStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        systemPrompt: undefined,
        tools: expect.any(Array),
      }),
      expect.objectContaining({ temperature: 0.2 }),
    );
    expect(getCapturedPayload()).toMatchObject({
      cachedContent: "cachedContents/system-cache-1",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.customType).toBe("openclaw.google-prompt-cache");
    expect((entries[0]?.data as { status?: string; cachedContent?: string })?.status).toBe("ready");
  });

  it("reuses a persisted cache entry without creating a second cache", async () => {
    const now = 2_000_000;
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const fetchMock = createCacheFetchMock({
      expireTime: new Date(now + 3_600_000).toISOString(),
      name: "cachedContents/system-cache-2",
    });

    await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: vi.fn(() => "first" as never),
    });

    fetchMock.mockClear();
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn("second");
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: now + 30_000,
      sessionManager,
      streamFn: innerStreamFn,
    });

    void wrapped?.(
      makeGoogleModel(),
      { messages: [], systemPrompt: "Follow policy." } as never,
      {} as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemPrompt: undefined }),
      expect.any(Object),
    );
    expect(getCapturedPayload()).toMatchObject({
      cachedContent: "cachedContents/system-cache-2",
    });
  });

  it("refreshes an about-to-expire cache entry instead of creating a new one", async () => {
    const now = 3_000_000;
    const expireSoon = new Date(now + 60_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const sessionManager = makeSessionManager([
      {
        customType: "openclaw.google-prompt-cache",
        data: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          cacheRetention: "long",
          cachedContent: "cachedContents/system-cache-3",
          expireTime: expireSoon,
          modelApi: "google-generative-ai",
          modelId: "gemini-3.1-pro-preview",
          provider: "google",
          status: "ready",
          systemPromptDigest,
          timestamp: now - 5000,
        },
        id: "entry-1",
        parentId: null,
        timestamp: new Date(now - 5000).toISOString(),
        type: "custom",
      },
    ]);
    const fetchMock = createCacheFetchMock({
      expireTime: new Date(now + 3_600_000).toISOString(),
      name: "cachedContents/system-cache-3",
    });
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    void wrapped?.(
      makeGoogleModel(),
      { messages: [], systemPrompt: "Follow policy." } as never,
      {} as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/system-cache-3?updateMask=ttl",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
    expect(innerStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemPrompt: undefined }),
      expect.any(Object),
    );
    expect(getCapturedPayload()).toMatchObject({
      cachedContent: "cachedContents/system-cache-3",
    });
  });

  it("stays out of the way when cachedContent is already configured explicitly", async () => {
    const fetchMock = vi.fn();

    const wrapped = await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: {
          cacheRetention: "long",
          cachedContent: "cachedContents/already-set",
        },
        model: makeGoogleModel(),
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager: makeSessionManager(),
        streamFn: vi.fn(() => "stream" as never),
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => fetchMock as typeof fetch,
        now: () => 0,
      },
    );

    expect(wrapped).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
