import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";
import { BYTEPLUS_CODING_MODEL_CATALOG, BYTEPLUS_MODEL_CATALOG } from "./models.js";

describe("byteplus plugin", () => {
  it("augments the catalog with bundled standard and plan models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({
      entries: [],
      env: process.env,
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        contextWindow: BYTEPLUS_MODEL_CATALOG[0].contextWindow,
        id: BYTEPLUS_MODEL_CATALOG[0].id,
        input: [...BYTEPLUS_MODEL_CATALOG[0].input],
        name: BYTEPLUS_MODEL_CATALOG[0].name,
        provider: "byteplus",
        reasoning: BYTEPLUS_MODEL_CATALOG[0].reasoning,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        contextWindow: BYTEPLUS_CODING_MODEL_CATALOG[0].contextWindow,
        id: BYTEPLUS_CODING_MODEL_CATALOG[0].id,
        input: [...BYTEPLUS_CODING_MODEL_CATALOG[0].input],
        name: BYTEPLUS_CODING_MODEL_CATALOG[0].name,
        provider: "byteplus-plan",
        reasoning: BYTEPLUS_CODING_MODEL_CATALOG[0].reasoning,
      }),
    );
  });

  it("declares its coding provider auth alias in the manifest", () => {
    const pluginJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf8"),
    );

    expect(pluginJson.providerAuthAliases).toEqual({
      "byteplus-plan": "byteplus",
    });
  });
});
