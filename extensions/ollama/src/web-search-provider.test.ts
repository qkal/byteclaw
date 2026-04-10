import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaWebSearchProvider as createContractOllamaWebSearchProvider } from "../web-search-contract-api.js";
import {
  createOllamaWebSearchProvider,
  runOllamaWebSearch,
  __testing as testing,
} from "./web-search-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type OllamaProviderConfigOverride = Partial<{
  api: "ollama";
  apiKey: string;
  baseUrl: string;
  models: NonNullable<
    NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
  >["models"];
}>;

function createOllamaConfig(provider: OllamaProviderConfigOverride = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          api: "ollama",
          baseUrl: "http://ollama.local:11434/v1",
          models: [],
          ...provider,
        },
      },
    },
  };
}

function createSetupNotes() {
  const notes: { title?: string; message: string }[] = [];
  return {
    notes,
    prompter: {
      note: async (message: string, title?: string) => {
        notes.push({ message, title });
      },
    },
  };
}

describe("ollama web search provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers a keyless web search provider", () => {
    expect(createContractOllamaWebSearchProvider()).toMatchObject({
      envVars: [],
      id: "ollama",
      label: "Ollama Web Search",
      requiresCredential: false,
    });
  });

  it("uses the configured Ollama host and enables the plugin in config", () => {
    const provider = createOllamaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }

    const applied = provider.applySelectionConfig({});

    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.ollama?.enabled).toBe(true);
    expect(
      testing.resolveOllamaWebSearchBaseUrl({
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://ollama.local:11434/v1",
              models: [],
            },
          },
        },
      }),
    ).toBe("http://ollama.local:11434");
  });

  it("maps generic search args into the Ollama experimental search endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      release,
      response: new Response(
        JSON.stringify({
          results: [
            {
              content: "Gateway docs and setup details",
              title: "OpenClaw",
              url: "https://openclaw.ai/docs",
            },
          ],
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    });

    const provider = createOllamaWebSearchProvider();
    const tool = provider.createTool({
      config: createOllamaConfig(),
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({ count: 3, query: "openclaw docs" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "ollama-web-search.search",
        url: "http://ollama.local:11434/api/experimental/web_search",
      }),
    );
    expect(
      JSON.parse(
        String(
          (
            fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
              init?: { body?: string };
            }
          ).init?.body,
        ),
      ),
    ).toEqual({
      max_results: 3,
      query: "openclaw docs",
    });
    expect(result).toMatchObject({
      count: 1,
      provider: "ollama",
      query: "openclaw docs",
      results: [{ url: "https://openclaw.ai/docs" }],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("surfaces Ollama signin guidance for 401 responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: new Response("", { status: 401 }),
    });

    await expect(runOllamaWebSearch({ query: "latest openclaw release" })).rejects.toThrow(
      "ollama signin",
    );
  });

  it("warns when Ollama is not reachable during setup without cancelling", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));

    const config = createOllamaConfig();
    const { notes, prompter } = createSetupNotes();

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter,
    });

    expect(next).toBe(config);
    expect(notes).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("requires Ollama to be running"),
        title: "Ollama Web Search",
      }),
    ]);
  });

  it("resolves env var when config apiKey is a marker string", () => {
    const original = process.env.OLLAMA_API_KEY;
    try {
      process.env.OLLAMA_API_KEY = "real-secret-from-env";
      const key = testing.resolveOllamaWebSearchApiKey(
        createOllamaConfig({
          apiKey: "OLLAMA_API_KEY",
          baseUrl: "http://localhost:11434",
        }),
      );
      expect(key).toBe("real-secret-from-env");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }
  });

  it("warns when ollama signin is missing during setup without cancelling", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ models: [] }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({ error: "not signed in", signin_url: "https://ollama.com/signin" }),
          {
            headers: { "Content-Type": "application/json" },
            status: 401,
          },
        ),
      });

    const config = createOllamaConfig();
    const { notes, prompter } = createSetupNotes();

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter,
    });

    expect(next).toBe(config);
    expect(notes).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Ollama Web Search requires `ollama signin`."),
        title: "Ollama Web Search",
      }),
    ]);
    expect(notes[0]?.message).toContain("https://ollama.com/signin");
  });
});
