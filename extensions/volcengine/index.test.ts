import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";
import { DOUBAO_CODING_MODEL_CATALOG, DOUBAO_MODEL_CATALOG } from "./models.js";

describe("volcengine plugin", () => {
  it("augments the catalog with bundled standard and plan models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({
      entries: [],
      env: process.env,
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        contextWindow: DOUBAO_MODEL_CATALOG[0].contextWindow,
        id: DOUBAO_MODEL_CATALOG[0].id,
        input: [...DOUBAO_MODEL_CATALOG[0].input],
        name: DOUBAO_MODEL_CATALOG[0].name,
        provider: "volcengine",
        reasoning: DOUBAO_MODEL_CATALOG[0].reasoning,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        contextWindow: DOUBAO_CODING_MODEL_CATALOG[0].contextWindow,
        id: DOUBAO_CODING_MODEL_CATALOG[0].id,
        input: [...DOUBAO_CODING_MODEL_CATALOG[0].input],
        name: DOUBAO_CODING_MODEL_CATALOG[0].name,
        provider: "volcengine-plan",
        reasoning: DOUBAO_CODING_MODEL_CATALOG[0].reasoning,
      }),
    );
  });

  it("declares its coding provider auth alias in the manifest", () => {
    const pluginJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf8"),
    );

    expect(pluginJson.providerAuthAliases).toEqual({
      "volcengine-plan": "volcengine",
    });
  });
});
