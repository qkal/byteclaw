import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import OpenAI from "openai";
import type { ResolvedTtsConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { encodePngRgba, fillPixel } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_OPENAI_PLUGIN_MODEL?.trim() || "gpt-5.4-nano";
const LIVE_IMAGE_MODEL = process.env.OPENCLAW_LIVE_OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1";
const LIVE_VISION_MODEL = process.env.OPENCLAW_LIVE_OPENAI_VISION_MODEL?.trim() || "gpt-4.1-mini";
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const EMPTY_AUTH_STORE = { profiles: {}, version: 1 } as const;
const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
};

function resolveTemplateModelId(modelId: string) {
  switch (modelId) {
    case "gpt-5.4": {
      return "gpt-5.2";
    }
    case "gpt-5.4-mini": {
      return "gpt-5-mini";
    }
    case "gpt-5.4-nano": {
      return "gpt-5-nano";
    }
    default: {
      throw new Error(`Unsupported live OpenAI plugin model: ${modelId}`);
    }
  }
}

function createTemplateModelRegistry(modelId: string): ModelRegistry {
  const registry = new ModelRegistryCtor(AuthStorage.inMemory());
  const template = getModel("openai", resolveTemplateModelId(modelId));
  registry.registerProvider("openai", {
    apiKey: "test",
    baseUrl: template.baseUrl,
    models: [
      {
        api: template.api,
        contextWindow: template.contextWindow,
        cost: template.cost,
        id: template.id,
        input: template.input,
        maxTokens: template.maxTokens,
        name: template.name,
        reasoning: template.reasoning,
        ...(template.compat ? { compat: template.compat } : {}),
      },
    ],
  });
  return registry;
}

const registerOpenAIPlugin = () =>
  registerProviderPlugin({
    id: "openai",
    name: "OpenAI Provider",
    plugin,
  });

function createReferencePng(): Buffer {
  const width = 96;
  const height = 96;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 225, 242, 255, 255);
    }
  }

  for (let y = 24; y < 72; y += 1) {
    for (let x = 24; x < 72; x += 1) {
      fillPixel(buf, x, y, width, 255, 153, 51, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function createLiveConfig(): OpenClawConfig {
  const cfg = loadConfig();
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        openai: {
          ...cfg.models?.providers?.openai,
          apiKey: OPENAI_API_KEY,
          baseUrl: "https://api.openai.com/v1",
        },
      },
    },
  } as OpenClawConfig;
}

function createLiveTtsConfig(): ResolvedTtsConfig {
  return {
    auto: "off",
    maxTextLength: 4000,
    mode: "final",
    modelOverrides: {
      allowModelId: true,
      allowNormalization: true,
      allowProvider: true,
      allowSeed: true,
      allowText: true,
      allowVoice: true,
      allowVoiceSettings: true,
      enabled: true,
    },
    provider: "openai",
    providerConfigs: {
      openai: {
        apiKey: OPENAI_API_KEY,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
    providerSource: "config",
    timeoutMs: 30_000,
  };
}

async function createTempAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openai-plugin-live-"));
}

describeLive("openai plugin live", () => {
  it("registers an OpenAI provider that can complete a live request", async () => {
    const { providers } = await registerOpenAIPlugin();
    const provider = requireRegisteredProvider(providers, "openai");

    const resolved = provider.resolveDynamicModel?.({
      modelId: LIVE_MODEL_ID,
      modelRegistry: createTemplateModelRegistry(LIVE_MODEL_ID),
      provider: "openai",
    });

    if (!resolved) {
      throw new Error("openai provider did not resolve the live model");
    }

    const normalized = provider.normalizeResolvedModel?.({
      model: resolved,
      modelId: resolved.id,
      provider: "openai",
    });

    expect(normalized).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      id: LIVE_MODEL_ID,
      provider: "openai",
    });

    const client = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: normalized?.baseUrl,
    });
    const response = await client.responses.create({
      input: "Reply with exactly OK.",
      max_output_tokens: 16,
      model: normalized?.id ?? LIVE_MODEL_ID,
    });

    expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
  }, 30_000);

  it("lists voices and synthesizes audio through the registered speech provider", async () => {
    const { speechProviders } = await registerOpenAIPlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "openai");

    const voices = await speechProvider.listVoices?.({});
    if (!voices) {
      throw new Error("openai speech provider did not return voices");
    }
    expect(voices).toEqual(expect.arrayContaining([expect.objectContaining({ id: "alloy" })]));

    const cfg = createLiveConfig();
    const ttsConfig = createLiveTtsConfig();

    const audioFile = await speechProvider.synthesize({
      cfg,
      providerConfig: ttsConfig.providerConfigs.openai ?? {},
      target: "audio-file",
      text: "OpenClaw integration test OK.",
      timeoutMs: ttsConfig.timeoutMs,
    });
    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);

    const telephony = await speechProvider.synthesizeTelephony?.({
      cfg,
      providerConfig: ttsConfig.providerConfigs.openai ?? {},
      text: "Telephony check OK.",
      timeoutMs: ttsConfig.timeoutMs,
    });
    expect(telephony?.outputFormat).toBe("pcm");
    expect(telephony?.sampleRate).toBe(24_000);
    expect(telephony?.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 45_000);

  it("transcribes synthesized speech through the registered media provider", async () => {
    const { speechProviders, mediaProviders } = await registerOpenAIPlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "openai");
    const mediaProvider = requireRegisteredProvider(mediaProviders, "openai");

    const cfg = createLiveConfig();
    const ttsConfig = createLiveTtsConfig();

    const synthesized = await speechProvider.synthesize({
      cfg,
      providerConfig: ttsConfig.providerConfigs.openai ?? {},
      target: "audio-file",
      text: "OpenClaw integration test OK.",
      timeoutMs: ttsConfig.timeoutMs,
    });

    const transcription = await mediaProvider.transcribeAudio?.({
      apiKey: OPENAI_API_KEY,
      buffer: synthesized.audioBuffer,
      fileName: "openai-plugin-live.mp3",
      mime: "audio/mpeg",
      timeoutMs: 30_000,
    });

    const text = String(transcription?.text ?? "").toLowerCase();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("openclaw");
    expect(text).toMatch(/\bok\b/);
  }, 45_000);

  it("generates an image through the registered image provider", async () => {
    const { imageProviders } = await registerOpenAIPlugin();
    const imageProvider = requireRegisteredProvider(imageProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      const generated = await imageProvider.generateImage({
        agentDir,
        authStore: EMPTY_AUTH_STORE,
        cfg,
        model: LIVE_IMAGE_MODEL,
        prompt: "Create a minimal flat orange square centered on a white background.",
        provider: "openai",
        size: "1024x1024",
        timeoutMs: 45_000,
      });

      expect(generated.model).toBe(LIVE_IMAGE_MODEL);
      expect(generated.images.length).toBeGreaterThan(0);
      expect(generated.images[0]?.mimeType).toBe("image/png");
      expect(generated.images[0]?.buffer.byteLength).toBeGreaterThan(1000);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  }, 60_000);

  it("edits a reference image through the registered image provider", async () => {
    const { imageProviders } = await registerOpenAIPlugin();
    const imageProvider = requireRegisteredProvider(imageProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      const edited = await imageProvider.generateImage({
        agentDir,
        authStore: EMPTY_AUTH_STORE,
        cfg,
        inputImages: [
          {
            buffer: createReferencePng(),
            fileName: "reference.png",
            mimeType: "image/png",
          },
        ],
        model: LIVE_IMAGE_MODEL,
        prompt:
          "Edit this image: remove the orange square in the center and keep the background clean and light blue.",
        provider: "openai",
        size: "1024x1024",
        timeoutMs: 45_000,
      });

      expect(edited.model).toBe(LIVE_IMAGE_MODEL);
      expect(edited.images.length).toBeGreaterThan(0);
      expect(edited.images[0]?.mimeType).toBe("image/png");
      expect(edited.images[0]?.buffer.byteLength).toBeGreaterThan(1000);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  }, 60_000);

  it("describes a deterministic image through the registered media provider", async () => {
    const { mediaProviders } = await registerOpenAIPlugin();
    const mediaProvider = requireRegisteredProvider(mediaProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      const description = await mediaProvider.describeImage?.({
        agentDir,
        buffer: createReferencePng(),
        cfg,
        fileName: "reference.png",
        mime: "image/png",
        model: LIVE_VISION_MODEL,
        prompt: "Reply with one lowercase word for the dominant center color.",
        provider: "openai",
        timeoutMs: 30_000,
      });

      expect(String(description?.text ?? "").toLowerCase()).toContain("orange");
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  }, 60_000);
});
