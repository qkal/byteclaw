import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEntriesWithActiveFallback, resolveModelEntries } from "./resolve.js";
import type { MediaUnderstandingCapability } from "./types.js";

const providerRegistry = new Map<string, { capabilities: MediaUnderstandingCapability[] }>([
  ["openai", { capabilities: ["image"] }],
  ["groq", { capabilities: ["audio"] }],
]);

describe("resolveModelEntries", () => {
  it("uses provider capabilities for shared entries without explicit caps", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ model: "gpt-5.4", provider: "openai" }],
        },
      },
    };

    const imageEntries = resolveModelEntries({
      capability: "image",
      cfg,
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(1);

    const audioEntries = resolveModelEntries({
      capability: "audio",
      cfg,
      providerRegistry,
    });
    expect(audioEntries).toHaveLength(0);
  });

  it("keeps per-capability entries even without explicit caps", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          image: {
            models: [{ model: "gpt-5.4", provider: "openai" }],
          },
        },
      },
    };

    const imageEntries = resolveModelEntries({
      capability: "image",
      cfg,
      config: cfg.tools?.media?.image,
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(1);
  });

  it("skips shared CLI entries without capabilities", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ args: ["--file", "{{MediaPath}}"], command: "gemini", type: "cli" }],
        },
      },
    };

    const entries = resolveModelEntries({
      capability: "image",
      cfg,
      providerRegistry,
    });
    expect(entries).toHaveLength(0);
  });
});

describe("resolveEntriesWithActiveFallback", () => {
  type ResolveWithFallbackInput = Parameters<typeof resolveEntriesWithActiveFallback>[0];
  const defaultActiveModel = { model: "whisper-large-v3", provider: "groq" } as const;

  function resolveWithActiveFallback(params: {
    cfg: ResolveWithFallbackInput["cfg"];
    capability: ResolveWithFallbackInput["capability"];
    config: ResolveWithFallbackInput["config"];
  }) {
    return resolveEntriesWithActiveFallback({
      activeModel: defaultActiveModel,
      capability: params.capability,
      cfg: params.cfg,
      config: params.config,
      providerRegistry,
    });
  }

  function expectResolvedProviders(params: {
    cfg: OpenClawConfig;
    capability: ResolveWithFallbackInput["capability"];
    config: ResolveWithFallbackInput["config"];
    providers: string[];
  }) {
    const entries = resolveWithActiveFallback({
      capability: params.capability,
      cfg: params.cfg,
      config: params.config,
    });
    expect(entries).toHaveLength(params.providers.length);
    expect(entries.map((entry) => entry.provider)).toEqual(params.providers);
  }

  it("uses active model when enabled and no models are configured", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: { enabled: true },
        },
      },
    };

    expectResolvedProviders({
      capability: "audio",
      cfg,
      config: cfg.tools?.media?.audio,
      providers: ["groq"],
    });
  });

  it("ignores active model when configured entries exist", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: { enabled: true, models: [{ model: "whisper-1", provider: "openai" }] },
        },
      },
    };

    expectResolvedProviders({
      capability: "audio",
      cfg,
      config: cfg.tools?.media?.audio,
      providers: ["openai"],
    });
  });

  it("skips active model when provider lacks capability", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          video: { enabled: true },
        },
      },
    };

    const entries = resolveWithActiveFallback({
      capability: "video",
      cfg,
      config: cfg.tools?.media?.video,
    });
    expect(entries).toHaveLength(0);
  });
});
