import { describe, expect, it } from "vitest";
import {
  buildConfigChecks,
  evaluateRequirements,
  evaluateRequirementsFromMetadata,
  evaluateRequirementsFromMetadataWithRemote,
  resolveMissingAnyBins,
  resolveMissingBins,
  resolveMissingEnv,
  resolveMissingOs,
} from "./requirements.js";

describe("requirements helpers", () => {
  it("resolveMissingBins respects local+remote", () => {
    expect(
      resolveMissingBins({
        hasLocalBin: (bin) => bin === "a",
        hasRemoteBin: (bin) => bin === "b",
        required: ["a", "b", "c"],
      }),
    ).toEqual(["c"]);
  });

  it("resolveMissingAnyBins requires at least one", () => {
    expect(
      resolveMissingAnyBins({
        hasLocalBin: () => false,
        required: [],
      }),
    ).toEqual([]);
    expect(
      resolveMissingAnyBins({
        hasLocalBin: () => false,
        hasRemoteAnyBin: () => false,
        required: ["a", "b"],
      }),
    ).toEqual(["a", "b"]);
    expect(
      resolveMissingAnyBins({
        hasLocalBin: (bin) => bin === "b",
        required: ["a", "b"],
      }),
    ).toEqual([]);
  });

  it("resolveMissingOs allows remote platform", () => {
    expect(resolveMissingOs({ localPlatform: "linux", required: [] })).toEqual([]);
    expect(resolveMissingOs({ localPlatform: "linux", required: ["linux"] })).toEqual([]);
    expect(
      resolveMissingOs({
        localPlatform: "linux",
        remotePlatforms: ["darwin"],
        required: ["darwin"],
      }),
    ).toEqual([]);
    expect(resolveMissingOs({ localPlatform: "linux", required: ["darwin"] })).toEqual(["darwin"]);
  });

  it("resolveMissingEnv uses predicate", () => {
    expect(
      resolveMissingEnv({ isSatisfied: (name) => name === "B", required: ["A", "B"] }),
    ).toEqual(["A"]);
  });

  it("buildConfigChecks includes status", () => {
    expect(
      buildConfigChecks({
        isSatisfied: (p) => p === "a.b",
        required: ["a.b"],
      }),
    ).toEqual([{ path: "a.b", satisfied: true }]);
  });

  it("evaluateRequirementsFromMetadata derives required+missing", () => {
    const res = evaluateRequirementsFromMetadata({
      always: false,
      hasLocalBin: (bin) => bin === "a",
      isConfigSatisfied: () => false,
      isEnvSatisfied: (name) => name === "E",
      localPlatform: "linux",
      metadata: {
        os: ["darwin"],
        requires: { anyBins: ["b"], bins: ["a"], config: ["cfg.value"], env: ["E"] },
      },
    });

    expect(res.required.bins).toEqual(["a"]);
    expect(res.missing.config).toEqual(["cfg.value"]);
    expect(res.missing.os).toEqual(["darwin"]);
    expect(res.eligible).toBe(false);
  });

  it("evaluateRequirements reports config checks and all missing categories directly", () => {
    const res = evaluateRequirements({
      always: false,
      hasLocalBin: () => false,
      hasRemoteAnyBin: () => false,
      hasRemoteBin: (bin) => bin === "node",
      isConfigSatisfied: (path) => path === "gateway.enabled",
      isEnvSatisfied: () => false,
      localPlatform: "linux",
      remotePlatforms: ["windows"],
      required: {
        anyBins: ["bun", "deno"],
        bins: ["node"],
        config: ["browser.enabled", "gateway.enabled"],
        env: ["OPENAI_API_KEY"],
        os: ["darwin"],
      },
    });

    expect(res.missing).toEqual({
      anyBins: ["bun", "deno"],
      bins: [],
      config: ["browser.enabled"],
      env: ["OPENAI_API_KEY"],
      os: ["darwin"],
    });
    expect(res.configChecks).toEqual([
      { path: "browser.enabled", satisfied: false },
      { path: "gateway.enabled", satisfied: true },
    ]);
    expect(res.eligible).toBe(false);
  });

  it("clears missing requirements when always is true but preserves config checks", () => {
    const res = evaluateRequirements({
      always: true,
      hasLocalBin: () => false,
      isConfigSatisfied: () => false,
      isEnvSatisfied: () => false,
      localPlatform: "linux",
      required: {
        anyBins: ["bun"],
        bins: ["node"],
        config: ["browser.enabled"],
        env: ["OPENAI_API_KEY"],
        os: ["darwin"],
      },
    });

    expect(res.missing).toEqual({ anyBins: [], bins: [], config: [], env: [], os: [] });
    expect(res.configChecks).toEqual([{ path: "browser.enabled", satisfied: false }]);
    expect(res.eligible).toBe(true);
  });

  it("evaluateRequirementsFromMetadataWithRemote wires remote predicates and platforms through", () => {
    const res = evaluateRequirementsFromMetadataWithRemote({
      always: false,
      hasLocalBin: () => false,
      isConfigSatisfied: () => true,
      isEnvSatisfied: (name) => name === "OPENAI_API_KEY",
      localPlatform: "linux",
      metadata: {
        os: ["darwin"],
        requires: { anyBins: ["bun"], bins: ["node"], env: ["OPENAI_API_KEY"] },
      },
      remote: {
        hasAnyBin: (bins) => bins.includes("bun"),
        hasBin: (bin) => bin === "node",
        platforms: ["darwin"],
      },
    });

    expect(res.required).toEqual({
      anyBins: ["bun"],
      bins: ["node"],
      config: [],
      env: ["OPENAI_API_KEY"],
      os: ["darwin"],
    });
    expect(res.missing).toEqual({ anyBins: [], bins: [], config: [], env: [], os: [] });
    expect(res.eligible).toBe(true);
  });

  it("evaluateRequirementsFromMetadata defaults missing metadata to empty requirements", () => {
    const res = evaluateRequirementsFromMetadata({
      always: false,
      hasLocalBin: () => false,
      isConfigSatisfied: () => false,
      isEnvSatisfied: () => false,
      localPlatform: "linux",
    });

    expect(res.required).toEqual({
      anyBins: [],
      bins: [],
      config: [],
      env: [],
      os: [],
    });
    expect(res.missing).toEqual({
      anyBins: [],
      bins: [],
      config: [],
      env: [],
      os: [],
    });
    expect(res.configChecks).toEqual([]);
    expect(res.eligible).toBe(true);
  });
});
