import { describe, expect, it } from "vitest";
import { buildOutboundMediaLoadOptions, resolveOutboundMediaLocalRoots } from "./load-options.js";

describe("media load options", () => {
  function expectResolvedOutboundMediaRoots(
    mediaLocalRoots: readonly string[] | undefined,
    expectedLocalRoots: readonly string[] | undefined,
  ) {
    expect(resolveOutboundMediaLocalRoots(mediaLocalRoots)).toEqual(expectedLocalRoots);
  }

  function expectBuiltOutboundMediaLoadOptions(
    params: Parameters<typeof buildOutboundMediaLoadOptions>[0],
    expected: ReturnType<typeof buildOutboundMediaLoadOptions>,
  ) {
    expect(buildOutboundMediaLoadOptions(params)).toEqual(expected);
  }

  it.each([
    { expectedLocalRoots: undefined, mediaLocalRoots: undefined },
    { expectedLocalRoots: undefined, mediaLocalRoots: [] },
    { expectedLocalRoots: ["/tmp/workspace"], mediaLocalRoots: ["/tmp/workspace"] },
  ] as const)("resolves outbound local roots %#", ({ mediaLocalRoots, expectedLocalRoots }) => {
    expectResolvedOutboundMediaRoots(mediaLocalRoots, expectedLocalRoots);
  });

  it.each([
    {
      expected: { localRoots: ["/tmp/workspace"], maxBytes: 1024 },
      params: { maxBytes: 1024, mediaLocalRoots: ["/tmp/workspace"] },
    },
    {
      expected: { localRoots: undefined, maxBytes: 2048 },
      params: { maxBytes: 2048, mediaLocalRoots: undefined },
    },
  ] as const)("builds outbound media load options %#", ({ params, expected }) => {
    expectBuiltOutboundMediaLoadOptions(params, expected);
  });
});
