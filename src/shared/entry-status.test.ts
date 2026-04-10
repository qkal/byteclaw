import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateEntryMetadataRequirements,
  evaluateEntryMetadataRequirementsForCurrentPlatform,
  evaluateEntryRequirementsForCurrentPlatform,
} from "./entry-status.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("shared/entry-status", () => {
  it("combines metadata presentation fields with evaluated requirements", () => {
    const result = evaluateEntryMetadataRequirements({
      always: false,
      frontmatter: {
        emoji: "🙂",
        homepage: "https://docs.openclaw.ai",
      },
      hasLocalBin: (bin) => bin === "bun",
      isConfigSatisfied: (path) => path === "gateway.bind",
      isEnvSatisfied: () => false,
      localPlatform: "linux",
      metadata: {
        emoji: "🦀",
        homepage: "https://openclaw.ai",
        os: ["darwin"],
        requires: {
          anyBins: ["ffmpeg", "sox"],
          bins: ["bun"],
          config: ["gateway.bind"],
          env: ["OPENCLAW_TOKEN"],
        },
      },
      remote: {
        hasAnyBin: (bins) => bins.includes("sox"),
      },
    });

    expect(result).toEqual({
      configChecks: [{ path: "gateway.bind", satisfied: true }],
      emoji: "🦀",
      homepage: "https://openclaw.ai",
      missing: {
        anyBins: [],
        bins: [],
        config: [],
        env: ["OPENCLAW_TOKEN"],
        os: ["darwin"],
      },
      required: {
        anyBins: ["ffmpeg", "sox"],
        bins: ["bun"],
        config: ["gateway.bind"],
        env: ["OPENCLAW_TOKEN"],
        os: ["darwin"],
      },
      requirementsSatisfied: false,
    });
  });

  it("uses process.platform in the current-platform wrapper", () => {
    setPlatform("darwin");

    const result = evaluateEntryMetadataRequirementsForCurrentPlatform({
      always: false,
      hasLocalBin: () => false,
      isConfigSatisfied: () => true,
      isEnvSatisfied: () => true,
      metadata: {
        os: ["darwin"],
      },
    });

    expect(result.requirementsSatisfied).toBe(true);
    expect(result.missing.os).toEqual([]);
  });

  it("pulls metadata and frontmatter from entry objects in the entry wrapper", () => {
    setPlatform("linux");

    const result = evaluateEntryRequirementsForCurrentPlatform({
      always: true,
      entry: {
        frontmatter: {
          emoji: "🙂",
          website: " https://docs.openclaw.ai ",
        },
        metadata: {
          requires: {
            bins: ["missing-bin"],
          },
        },
      },
      hasLocalBin: () => false,
      isConfigSatisfied: () => false,
      isEnvSatisfied: () => false,
    });

    expect(result).toEqual({
      configChecks: [],
      emoji: "🙂",
      homepage: "https://docs.openclaw.ai",
      missing: {
        anyBins: [],
        bins: [],
        config: [],
        env: [],
        os: [],
      },
      required: {
        anyBins: [],
        bins: ["missing-bin"],
        config: [],
        env: [],
        os: [],
      },
      requirementsSatisfied: true,
    });
  });

  it("returns empty requirements when metadata and frontmatter are missing", () => {
    const result = evaluateEntryMetadataRequirements({
      always: false,
      hasLocalBin: () => false,
      isConfigSatisfied: () => false,
      isEnvSatisfied: () => false,
      localPlatform: "linux",
    });

    expect(result).toEqual({
      configChecks: [],
      missing: {
        anyBins: [],
        bins: [],
        config: [],
        env: [],
        os: [],
      },
      required: {
        anyBins: [],
        bins: [],
        config: [],
        env: [],
        os: [],
      },
      requirementsSatisfied: true,
    });
  });
});
