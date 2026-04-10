import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../../../src/test-helpers/http.js";
import {
  type OllamaTagModel,
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  resolveOllamaApiBase,
} from "./provider-models.js";

describe("ollama provider models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips /v1 when resolving the Ollama API base", () => {
    expect(resolveOllamaApiBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaApiBase("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
  });

  it("sets discovered models with context windows from /api/show", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3:8b" }, { name: "deepseek-r1:14b" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "llama3:8b") {
        return jsonResponse({ model_info: { "llama.context_length": 65_536 } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      { capabilities: undefined, contextWindow: 65_536, name: "llama3:8b" },
      { capabilities: undefined, contextWindow: undefined, name: "deepseek-r1:14b" },
    ]);
  });

  it("sets models with vision capability from /api/show capabilities", async () => {
    const models: OllamaTagModel[] = [{ name: "kimi-k2.5:cloud" }, { name: "glm-5.1:cloud" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "kimi-k2.5:cloud") {
        return jsonResponse({
          capabilities: ["vision", "thinking", "completion", "tools"],
          model_info: { "kimi-k2.context_length": 262_144 },
        });
      }
      if (body.name === "glm-5.1:cloud") {
        return jsonResponse({
          capabilities: ["thinking", "completion", "tools"],
          model_info: { "glm5.context_length": 202_752 },
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      {
        capabilities: ["vision", "thinking", "completion", "tools"],
        contextWindow: 262_144,
        name: "kimi-k2.5:cloud",
      },
      {
        capabilities: ["thinking", "completion", "tools"],
        contextWindow: 202_752,
        name: "glm-5.1:cloud",
      },
    ]);
  });

  it("buildOllamaModelDefinition sets input to text+image when vision capability is present", () => {
    const visionModel = buildOllamaModelDefinition("kimi-k2.5:cloud", 262_144, [
      "vision",
      "completion",
      "tools",
    ]);
    expect(visionModel.input).toEqual(["text", "image"]);

    const textModel = buildOllamaModelDefinition("glm-5.1:cloud", 202_752, ["completion", "tools"]);
    expect(textModel.input).toEqual(["text"]);

    const noCapabilities = buildOllamaModelDefinition("unknown-model", 65_536);
    expect(noCapabilities.input).toEqual(["text"]);
  });
});
