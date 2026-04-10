import { describe, expect, it } from "vitest";
import { IMAGE_REDUCE_QUALITY_STEPS, buildImageResizeSideGrid } from "./image-ops.js";

describe("buildImageResizeSideGrid", () => {
  function expectImageResizeSideGridCase(width: number, height: number, expected: number[]) {
    expect(buildImageResizeSideGrid(width, height)).toEqual(expected);
  }

  it.each([
    { expected: [1200, 1000, 900, 800], height: 900, width: 1200 },
    { expected: [], height: 0, width: 0 },
  ] as const)("builds resize side grid for %ix%i", ({ width, height, expected }) => {
    expectImageResizeSideGridCase(width, height, [...expected]);
  });
});

describe("IMAGE_REDUCE_QUALITY_STEPS", () => {
  function expectQualityLadderCase(expectedQualityLadder: number[]) {
    expect([...IMAGE_REDUCE_QUALITY_STEPS]).toEqual(expectedQualityLadder);
  }

  it.each([
    {
      expectedQualityLadder: [85, 75, 65, 55, 45, 35],
      name: "keeps expected quality ladder",
    },
  ] as const)("$name", ({ expectedQualityLadder }) => {
    expectQualityLadderCase([...expectedQualityLadder]);
  });
});
