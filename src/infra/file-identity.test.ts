import { describe, expect, it } from "vitest";
import { type FileIdentityStat, sameFileIdentity } from "./file-identity.js";

function stat(dev: number | bigint, ino: number | bigint): FileIdentityStat {
  return { dev, ino };
}

describe("sameFileIdentity", () => {
  it.each([
    {
      expected: true,
      left: stat(7, 11),
      name: "accepts exact dev+ino match",
      platform: "linux" as const,
      right: stat(7, 11),
    },
    {
      expected: false,
      left: stat(7, 11),
      name: "rejects inode mismatch",
      platform: "linux" as const,
      right: stat(7, 12),
    },
    {
      expected: false,
      left: stat(7, 11),
      name: "rejects dev mismatch on non-windows",
      platform: "linux" as const,
      right: stat(8, 11),
    },
    {
      expected: false,
      left: stat(0, 11),
      name: "keeps dev strictness on linux when one side is zero",
      platform: "linux" as const,
      right: stat(8, 11),
    },
    {
      expected: true,
      left: stat(0, 11),
      name: "accepts win32 dev mismatch when either side is 0",
      platform: "win32" as const,
      right: stat(8, 11),
    },
    {
      expected: true,
      left: stat(7, 11),
      name: "accepts win32 dev mismatch when right side is 0",
      platform: "win32" as const,
      right: stat(0, 11),
    },
    {
      expected: false,
      left: stat(7, 11),
      name: "keeps dev strictness on win32 when both dev values are non-zero",
      platform: "win32" as const,
      right: stat(8, 11),
    },
    {
      expected: true,
      left: stat(0n, 11n),
      name: "handles bigint stats",
      platform: "win32" as const,
      right: stat(8n, 11n),
    },
  ])("$name", ({ left, right, platform, expected }) => {
    expect(sameFileIdentity(left, right, platform)).toBe(expected);
  });
});
