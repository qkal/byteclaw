import { streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";

describe("describeEmbeddedAgentStreamStrategy", () => {
  it("describes provider-owned stream paths explicitly", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        model: {
          api: "openai-completions",
          id: "qwen",
          provider: "ollama",
        } as never,
        providerStreamFn: vi.fn() as never,
        shouldUseWebSocketTransport: false,
      }),
    ).toBe("provider");
  });

  it("describes default OpenAI fallback shaping", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        model: {
          api: "openai-responses",
          id: "gpt-5.4",
          provider: "openai",
        } as never,
        shouldUseWebSocketTransport: false,
      }),
    ).toBe("boundary-aware:openai-responses");
  });

  it("describes default Codex fallback shaping", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        model: {
          api: "openai-codex-responses",
          id: "codex-mini-latest",
          provider: "openai-codex",
        } as never,
        shouldUseWebSocketTransport: false,
      }),
    ).toBe("boundary-aware:openai-codex-responses");
  });

  it("keeps custom session streams labeled as custom", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: vi.fn() as never,
        model: {
          api: "openai-responses",
          id: "gpt-5.4",
          provider: "openai",
        } as never,
        shouldUseWebSocketTransport: false,
      }),
    ).toBe("session-custom");
  });
});

describe("resolveEmbeddedAgentStreamFn", () => {
  it("prefers the resolved run api key over a later authStorage lookup", async () => {
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };

    await expect(
      resolveEmbeddedAgentApiKey({
        authStorage,
        provider: "openai",
        resolvedApiKey: "resolved-key",
      }),
    ).resolves.toBe("resolved-key");
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
  });

  it("still routes supported streamSimple fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      model: {
        api: "openai-responses",
        id: "gpt-5.4",
        provider: "openai",
      } as never,
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("routes Codex responses fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      model: {
        api: "openai-codex-responses",
        id: "codex-mini-latest",
        provider: "openai-codex",
      } as never,
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("injects the resolved run api key into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const authStorage = {
      getApiKey: vi.fn(async () => "storage-key"),
    };
    const streamFn = resolveEmbeddedAgentStreamFn({
      authStorage,
      currentStreamFn: undefined,
      model: {
        api: "openai-completions",
        id: "gpt-5.4",
        provider: "openai",
      } as never,
      providerStreamFn,
      resolvedApiKey: "resolved-key",
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
    });

    await expect(
      streamFn({ id: "gpt-5.4", provider: "openai" } as never, {} as never, {}),
    ).resolves.toMatchObject({
      apiKey: "resolved-key",
    });
    expect(authStorage.getApiKey).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });
});
