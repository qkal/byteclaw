import { describe, expect, it } from "vitest";
import {
  expandPathTokens,
  matchPathTokens,
  materializePathTokens,
  parsePathPattern,
} from "./target-registry-pattern.js";

describe("target registry pattern helpers", () => {
  it("matches wildcard and array tokens with stable capture ordering", () => {
    const tokens = parsePathPattern("agents.list[].memorySearch.providers.*.apiKey");
    const match = matchPathTokens(
      ["agents", "list", "2", "memorySearch", "providers", "openai", "apiKey"],
      tokens,
    );

    expect(match).toEqual({
      captures: ["2", "openai"],
    });
    expect(
      matchPathTokens(
        ["agents", "list", "x", "memorySearch", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
  });

  it("materializes sibling ref paths from wildcard and array captures", () => {
    const refTokens = parsePathPattern("agents.list[].memorySearch.providers.*.apiKeyRef");
    expect(materializePathTokens(refTokens, ["1", "anthropic"])).toEqual([
      "agents",
      "list",
      "1",
      "memorySearch",
      "providers",
      "anthropic",
      "apiKeyRef",
    ]);
    expect(materializePathTokens(refTokens, ["anthropic"])).toBeNull();
  });

  it("matches two wildcard captures in five-segment header paths", () => {
    const tokens = parsePathPattern("models.providers.*.headers.*");
    const match = matchPathTokens(
      ["models", "providers", "openai", "headers", "x-api-key"],
      tokens,
    );
    expect(match).toEqual({
      captures: ["openai", "x-api-key"],
    });
  });

  it("expands wildcard and array patterns over config objects", () => {
    const root = {
      agents: {
        list: [
          { memorySearch: { remote: { apiKey: "a" } } },
          { memorySearch: { remote: { apiKey: "b" } } },
        ],
      },
      talk: {
        providers: {
          openai: { apiKey: "oa" }, // Pragma: allowlist secret
          anthropic: { apiKey: "an" }, // Pragma: allowlist secret
        },
      },
    };

    const arrayMatches = expandPathTokens(
      root,
      parsePathPattern("agents.list[].memorySearch.remote.apiKey"),
    );
    expect(
      arrayMatches.map((entry) => ({
        captures: entry.captures,
        segments: entry.segments.join("."),
        value: entry.value,
      })),
    ).toEqual([
      {
        captures: ["0"],
        segments: "agents.list.0.memorySearch.remote.apiKey",
        value: "a",
      },
      {
        captures: ["1"],
        segments: "agents.list.1.memorySearch.remote.apiKey",
        value: "b",
      },
    ]);

    const wildcardMatches = expandPathTokens(root, parsePathPattern("talk.providers.*.apiKey"));
    expect(
      wildcardMatches
        .map((entry) => ({
          captures: entry.captures,
          segments: entry.segments.join("."),
          value: entry.value,
        }))
        .toSorted((left, right) => left.segments.localeCompare(right.segments)),
    ).toEqual([
      {
        captures: ["anthropic"],
        segments: "talk.providers.anthropic.apiKey",
        value: "an",
      },
      {
        captures: ["openai"],
        segments: "talk.providers.openai.apiKey",
        value: "oa",
      },
    ]);
  });
});
