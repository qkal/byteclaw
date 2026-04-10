import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";

async function withOpenRouterStateDir(run: (stateDir: string) => Promise<void>) {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-openrouter-capabilities-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await run(stateDir);
  } finally {
    rmSync(stateDir, { force: true, recursive: true });
  }
}

async function importOpenRouterModelCapabilities(scope: string) {
  return await importFreshModule<typeof import("./openrouter-model-capabilities.js")>(
    import.meta.url,
    `./openrouter-model-capabilities.js?scope=${scope}`,
  );
}

describe("openrouter-model-capabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("uses top-level OpenRouter max token fields when top_provider is absent", async () => {
    await withOpenRouterStateDir(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    architecture: { modality: "text+image->text" },
                    context_length: 65_432,
                    id: "acme/top-level-max-completion",
                    max_completion_tokens: 12_345,
                    name: "Top Level Max Completion",
                    pricing: { completion: "0.000002", prompt: "0.000001" },
                    supported_parameters: ["reasoning"],
                  },
                  {
                    context_length: 54_321,
                    id: "acme/top-level-max-output",
                    max_output_tokens: 23_456,
                    modality: "text+image->text",
                    name: "Top Level Max Output",
                    pricing: { completion: "0.000004", prompt: "0.000003" },
                  },
                ],
              }),
              {
                headers: { "content-type": "application/json" },
                status: 200,
              },
            ),
        ),
      );

      const module = await importOpenRouterModelCapabilities("top-level-max-tokens");
      await module.loadOpenRouterModelCapabilities("acme/top-level-max-completion");

      expect(module.getOpenRouterModelCapabilities("acme/top-level-max-completion")).toMatchObject({
        contextWindow: 65_432,
        input: ["text", "image"],
        maxTokens: 12_345,
        reasoning: true,
      });
      expect(module.getOpenRouterModelCapabilities("acme/top-level-max-output")).toMatchObject({
        contextWindow: 54_321,
        input: ["text", "image"],
        maxTokens: 23_456,
        reasoning: false,
      });
    });
  });

  it("does not refetch immediately after an awaited miss for the same model id", async () => {
    await withOpenRouterStateDir(async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  architecture: { modality: "text->text" },
                  context_length: 1234,
                  id: "acme/known-model",
                  name: "Known Model",
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const module = await importOpenRouterModelCapabilities("awaited-miss");
      await module.loadOpenRouterModelCapabilities("acme/missing-model");
      expect(module.getOpenRouterModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      expect(module.getOpenRouterModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
