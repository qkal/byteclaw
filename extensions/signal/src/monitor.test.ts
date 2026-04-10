import { describe, expect, it } from "vitest";
import { isSignalGroupAllowed } from "./identity.js";

describe("signal groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isSignalGroupAllowed({
        allowFrom: [],
        groupPolicy: "open",
        sender: { e164: "+15550001111", kind: "phone", raw: "+15550001111" },
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isSignalGroupAllowed({
        allowFrom: ["+15550001111"],
        groupPolicy: "disabled",
        sender: { e164: "+15550001111", kind: "phone", raw: "+15550001111" },
      }),
    ).toBe(false);
  });

  it("blocks allowlist when empty", () => {
    expect(
      isSignalGroupAllowed({
        allowFrom: [],
        groupPolicy: "allowlist",
        sender: { e164: "+15550001111", kind: "phone", raw: "+15550001111" },
      }),
    ).toBe(false);
  });

  it("allows allowlist when sender matches", () => {
    expect(
      isSignalGroupAllowed({
        allowFrom: ["+15550001111"],
        groupPolicy: "allowlist",
        sender: { e164: "+15550001111", kind: "phone", raw: "+15550001111" },
      }),
    ).toBe(true);
  });

  it("allows allowlist wildcard", () => {
    expect(
      isSignalGroupAllowed({
        allowFrom: ["*"],
        groupPolicy: "allowlist",
        sender: { e164: "+15550002222", kind: "phone", raw: "+15550002222" },
      }),
    ).toBe(true);
  });

  it("allows allowlist when uuid sender matches", () => {
    expect(
      isSignalGroupAllowed({
        allowFrom: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
        groupPolicy: "allowlist",
        sender: {
          kind: "uuid",
          raw: "123e4567-e89b-12d3-a456-426614174000",
        },
      }),
    ).toBe(true);
  });
});
