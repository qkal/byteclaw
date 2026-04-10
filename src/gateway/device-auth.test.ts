import { describe, expect, it } from "vitest";
import {
  buildDeviceAuthPayload,
  buildDeviceAuthPayloadV3,
  normalizeDeviceMetadataForAuth,
} from "./device-auth.js";

describe("device-auth payload vectors", () => {
  it.each([
    {
      build: () =>
        buildDeviceAuthPayload({
          clientId: "openclaw-macos",
          clientMode: "ui",
          deviceId: "dev-1",
          nonce: "nonce-abc",
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          signedAtMs: 1_700_000_000_000,
          token: null,
        }),
      expected:
        "v2|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000||nonce-abc",
      name: "builds canonical v2 payloads",
    },
    {
      build: () =>
        buildDeviceAuthPayloadV3({
          clientId: "openclaw-macos",
          clientMode: "ui",
          deviceFamily: "  iPhone  ",
          deviceId: "dev-1",
          nonce: "nonce-abc",
          platform: "  IOS  ",
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          signedAtMs: 1_700_000_000_000,
          token: "tok-123",
        }),
      expected:
        "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000|tok-123|nonce-abc|ios|iphone",
      name: "builds canonical v3 payloads",
    },
    {
      build: () =>
        buildDeviceAuthPayloadV3({
          clientId: "openclaw-ios",
          clientMode: "ui",
          deviceId: "dev-2",
          nonce: "nonce-def",
          role: "operator",
          scopes: ["operator.read"],
          signedAtMs: 1_700_000_000_001,
        }),
      expected: "v3|dev-2|openclaw-ios|ui|operator|operator.read|1700000000001||nonce-def||",
      name: "keeps empty metadata slots in v3 payloads",
    },
  ])("$name", ({ build, expected }) => {
    expect(build()).toBe(expected);
  });

  it.each([
    { expected: "İos", input: "  İOS  " },
    { expected: "mac", input: "  MAC  " },
    { expected: "", input: undefined },
  ])("normalizes metadata %j", ({ input, expected }) => {
    expect(normalizeDeviceMetadataForAuth(input)).toBe(expected);
  });
});
