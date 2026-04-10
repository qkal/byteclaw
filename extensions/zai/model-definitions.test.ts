import { describe, expect, it } from "vitest";
import { ZAI_DEFAULT_COST, buildZaiModelDefinition } from "./model-definitions.js";

describe("zai model definitions", () => {
  it("uses current Pi metadata for the new GLM-5.1 model", () => {
    expect(buildZaiModelDefinition({ id: "glm-5.1" })).toMatchObject({
      contextWindow: 202_800,
      cost: { cacheRead: 0.24, cacheWrite: 0, input: 1.2, output: 4 },
      id: "glm-5.1",
      input: ["text"],
      maxTokens: 131_100,
      reasoning: true,
    });
  });

  it("uses current Pi metadata for the new GLM-5V Turbo model", () => {
    expect(buildZaiModelDefinition({ id: "glm-5v-turbo" })).toMatchObject({
      contextWindow: 202_800,
      cost: { cacheRead: 0.24, cacheWrite: 0, input: 1.2, output: 4 },
      id: "glm-5v-turbo",
      input: ["text", "image"],
      maxTokens: 131_100,
      reasoning: true,
    });
  });

  it("uses current Pi metadata for the GLM-5 model", () => {
    expect(buildZaiModelDefinition({ id: "glm-5" })).toMatchObject({
      contextWindow: 202_800,
      cost: ZAI_DEFAULT_COST,
      id: "glm-5",
      input: ["text"],
      maxTokens: 131_100,
      reasoning: true,
    });
  });

  it("publishes newer GLM 4.5/4.6 family metadata from Pi", () => {
    expect(buildZaiModelDefinition({ id: "glm-4.6v" })).toMatchObject({
      contextWindow: 128_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 0.9 },
      id: "glm-4.6v",
      input: ["text", "image"],
      maxTokens: 32_768,
    });
    expect(buildZaiModelDefinition({ id: "glm-4.5-air" })).toMatchObject({
      contextWindow: 131_072,
      cost: { cacheRead: 0.03, cacheWrite: 0, input: 0.2, output: 1.1 },
      id: "glm-4.5-air",
      input: ["text"],
      maxTokens: 98_304,
    });
  });

  it("keeps the remaining GLM 4.7/5 pricing and token limits aligned with Pi", () => {
    expect(buildZaiModelDefinition({ id: "glm-4.7-flash" })).toMatchObject({
      contextWindow: 200_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0.07, output: 0.4 },
      id: "glm-4.7-flash",
      maxTokens: 131_072,
    });
    expect(buildZaiModelDefinition({ id: "glm-4.7-flashx" })).toMatchObject({
      contextWindow: 200_000,
      cost: { cacheRead: 0.01, cacheWrite: 0, input: 0.06, output: 0.4 },
      id: "glm-4.7-flashx",
      maxTokens: 128_000,
    });
    expect(buildZaiModelDefinition({ id: "glm-5-turbo" })).toMatchObject({
      contextWindow: 202_800,
      cost: { cacheRead: 0.24, cacheWrite: 0, input: 1.2, output: 4 },
      id: "glm-5-turbo",
      maxTokens: 131_100,
    });
  });
});
