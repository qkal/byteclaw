import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileOrder } from "./order.js";
import { markAuthProfileGood } from "./profiles.js";
import { saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    diagnostics: [],
    plugins: [
      {
        id: "fixture-provider",
        providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
      },
    ],
  })),
);

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

describe("resolveAuthProfileOrder", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockClear();
  });

  it("accepts aliased provider credentials from manifest metadata", () => {
    const store: AuthProfileStore = {
      profiles: {
        "fixture-provider:default": {
          key: "sk-test",
          provider: "fixture-provider",
          type: "api_key",
        },
      },
      version: 1,
    };

    const order = resolveAuthProfileOrder({
      provider: "fixture-provider-plan",
      store,
    });

    expect(order).toEqual(["fixture-provider:default"]);
  });

  it("marks aliased provider profiles good under the canonical auth provider", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-auth-profile-alias-"));
    try {
      const store: AuthProfileStore = {
        profiles: {
          "fixture-provider:default": {
            key: "sk-test",
            provider: "fixture-provider",
            type: "api_key",
          },
        },
        version: 1,
      };
      saveAuthProfileStore(store, agentDir);

      await markAuthProfileGood({
        agentDir,
        profileId: "fixture-provider:default",
        provider: "fixture-provider-plan",
        store,
      });

      expect(store.lastGood).toEqual({
        "fixture-provider": "fixture-provider:default",
      });
    } finally {
      await rm(agentDir, { force: true, recursive: true });
    }
  });
});
