import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINIMAX_CONTEXT_WINDOW,
  DEFAULT_MINIMAX_MAX_TOKENS,
  MINIMAX_API_COST,
  MINIMAX_API_HIGHSPEED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_M25_API_COST,
  MINIMAX_M25_API_HIGHSPEED_COST,
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
} from "./model-definitions.js";

describe("minimax model definitions", () => {
  it("uses M2.7 as default hosted model", () => {
    expect(MINIMAX_HOSTED_MODEL_ID).toBe("MiniMax-M2.7");
  });

  it("uses the higher upstream MiniMax context and token defaults", () => {
    expect(DEFAULT_MINIMAX_CONTEXT_WINDOW).toBe(204_800);
    expect(DEFAULT_MINIMAX_MAX_TOKENS).toBe(131_072);
    expect(MINIMAX_API_COST).toEqual({
      cacheRead: 0.06,
      cacheWrite: 0.375,
      input: 0.3,
      output: 1.2,
    });
  });

  it("builds catalog model with name and reasoning from catalog for M2.7", () => {
    const model = buildMinimaxModelDefinition({
      contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
      cost: MINIMAX_API_COST,
      id: "MiniMax-M2.7",
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
    });
    expect(model).toMatchObject({
      id: "MiniMax-M2.7",
      input: ["text", "image"],
      name: "MiniMax M2.7",
      reasoning: true, // M2.7 supports images
    });
  });

  it("builds non-catalog model with generated name and default reasoning", () => {
    const model = buildMinimaxModelDefinition({
      contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
      cost: MINIMAX_API_COST,
      id: "MiniMax-M2.5",
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
    });
    expect(model).toMatchObject({
      id: "MiniMax-M2.5",
      input: ["text"],
      name: "MiniMax MiniMax-M2.5",
      reasoning: false, // M2.5 is not image-capable
    });
  });

  it("builds API model definition with standard cost for M2.7", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
    expect(model.cost).toEqual(MINIMAX_API_COST);
    expect(model.contextWindow).toBe(DEFAULT_MINIMAX_CONTEXT_WINDOW);
    expect(model.maxTokens).toBe(DEFAULT_MINIMAX_MAX_TOKENS);
    expect(model.input).toEqual(["text", "image"]);
  });

  it("falls back to generated name for unknown model id", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-Future");
    expect(model.name).toBe("MiniMax MiniMax-Future");
    expect(model.reasoning).toBe(false);
  });

  it("M2.7 model includes image input", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
    expect(model.input).toEqual(["text", "image"]);
  });

  it("M2.7-highspeed model includes image input", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7-highspeed");
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual(MINIMAX_API_HIGHSPEED_COST);
  });

  it("M2.5 model remains text-only", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual(MINIMAX_M25_API_COST);
  });

  it("M2.5-highspeed keeps the M2.5 cache-read pricing", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5-highspeed");
    expect(model.cost).toEqual(MINIMAX_M25_API_HIGHSPEED_COST);
  });
});
