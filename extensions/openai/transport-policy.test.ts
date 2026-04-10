import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  resolveOpenAITransportTurnState,
  resolveOpenAIWebSocketSessionPolicy,
} from "./transport-policy.js";

describe("openai transport policy", () => {
  const nativeModel = {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 200_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: "gpt-5.4",
    input: ["text"],
    maxTokens: 8192,
    name: "GPT-5.4",
    provider: "openai",
    reasoning: true,
  } satisfies ProviderRuntimeModel;

  const proxyModel = {
    ...nativeModel,
    baseUrl: "https://proxy.example.com/v1",
    id: "proxy-model",
    name: "Proxy Model",
  } satisfies ProviderRuntimeModel;

  it("builds native turn state for direct OpenAI routes", () => {
    expect(
      resolveOpenAITransportTurnState({
        attempt: 2,
        model: nativeModel,
        modelId: nativeModel.id,
        provider: "openai",
        sessionId: "session-123",
        transport: "websocket",
        turnId: "turn-123",
      }),
    ).toMatchObject({
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
        "x-openclaw-turn-attempt": "2",
        "x-openclaw-turn-id": "turn-123",
      },
      metadata: {
        openclaw_session_id: "session-123",
        openclaw_transport: "websocket",
        openclaw_turn_attempt: "2",
        openclaw_turn_id: "turn-123",
      },
    });
  });

  it("skips turn state for proxy-like OpenAI routes", () => {
    expect(
      resolveOpenAITransportTurnState({
        attempt: 1,
        model: proxyModel,
        modelId: proxyModel.id,
        provider: "openai",
        sessionId: "session-123",
        transport: "stream",
        turnId: "turn-123",
      }),
    ).toBeUndefined();
  });

  it("returns websocket session headers and cooldown for native routes", () => {
    expect(
      resolveOpenAIWebSocketSessionPolicy({
        model: nativeModel,
        modelId: nativeModel.id,
        provider: "openai",
        sessionId: "session-123",
      }),
    ).toMatchObject({
      degradeCooldownMs: 60_000,
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
      },
    });
  });

  it("treats Azure routes as native OpenAI-family transports", () => {
    expect(
      resolveOpenAIWebSocketSessionPolicy({
        model: {
          ...nativeModel,
          baseUrl: "https://demo.openai.azure.com/openai/v1",
          provider: "azure-openai-responses",
        },
        modelId: "gpt-5.4",
        provider: "azure-openai-responses",
        sessionId: "session-123",
      }),
    ).toMatchObject({
      degradeCooldownMs: 60_000,
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
      },
    });
  });

  it("treats ChatGPT Codex backend routes as native OpenAI-family transports", () => {
    expect(
      resolveOpenAIWebSocketSessionPolicy({
        model: {
          ...nativeModel,
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          provider: "openai-codex",
        },
        modelId: "gpt-5.4",
        provider: "openai-codex",
        sessionId: "session-123",
      }),
    ).toMatchObject({
      degradeCooldownMs: 60_000,
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
      },
    });
  });
});
