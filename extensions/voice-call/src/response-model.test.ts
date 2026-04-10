import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CoreAgentDeps } from "./core-bridge.js";
import { resolveVoiceResponseModel } from "./response-model.js";

const agentRuntime = {
  defaults: {
    model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
    provider: "together",
  },
} as unknown as CoreAgentDeps;

describe("resolveVoiceResponseModel", () => {
  it("falls back to the runtime default model", () => {
    expect(
      resolveVoiceResponseModel({
        agentRuntime,
        voiceConfig: VoiceCallConfigSchema.parse({}),
      }),
    ).toEqual({
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
      modelRef: "together/Qwen/Qwen2.5-7B-Instruct-Turbo",
      provider: "together",
    });
  });

  it("uses an explicit provider/model ref", () => {
    expect(
      resolveVoiceResponseModel({
        agentRuntime,
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "openai/gpt-5.4-mini",
        }),
      }),
    ).toEqual({
      model: "gpt-5.4-mini",
      modelRef: "openai/gpt-5.4-mini",
      provider: "openai",
    });
  });

  it("uses the runtime default provider for bare model overrides", () => {
    expect(
      resolveVoiceResponseModel({
        agentRuntime,
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        }),
      }),
    ).toEqual({
      model: "Llama-4-Scout-17B-16E-Instruct",
      modelRef: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      provider: "meta-llama",
    });
  });

  it("keeps legacy single-segment overrides on the runtime default provider", () => {
    expect(
      resolveVoiceResponseModel({
        agentRuntime,
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "gpt-5.4-mini",
        }),
      }),
    ).toEqual({
      model: "gpt-5.4-mini",
      modelRef: "gpt-5.4-mini",
      provider: "together",
    });
  });
});
