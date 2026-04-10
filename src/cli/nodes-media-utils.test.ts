import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  resolveTempPathParts,
} from "./nodes-media-utils.js";

describe("cli/nodes-media-utils", () => {
  it("parses primitive helper values", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord("x")).toEqual({});
    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();
    expect(asNumber(1)).toBe(1);
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(1)).toBeUndefined();
  });

  it("normalizes temp path parts", () => {
    expect(resolveTempPathParts({ ext: "png", id: "id1", tmpDir: "/tmp" })).toEqual({
      ext: ".png",
      id: "id1",
      tmpDir: "/tmp",
    });
    expect(resolveTempPathParts({ ext: ".jpg", id: "id2", tmpDir: "/tmp" }).ext).toBe(".jpg");
  });
});
