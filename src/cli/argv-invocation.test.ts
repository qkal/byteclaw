import { describe, expect, it } from "vitest";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

describe("argv-invocation", () => {
  it("resolves root help and empty command path", () => {
    expect(resolveCliArgvInvocation(["node", "openclaw", "--help"])).toEqual({
      argv: ["node", "openclaw", "--help"],
      commandPath: [],
      hasHelpOrVersion: true,
      isRootHelpInvocation: true,
      primary: null,
    });
  });

  it("resolves command path and primary with root options", () => {
    expect(
      resolveCliArgvInvocation(["node", "openclaw", "--profile", "work", "gateway", "status"]),
    ).toEqual({
      argv: ["node", "openclaw", "--profile", "work", "gateway", "status"],
      commandPath: ["gateway", "status"],
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
      primary: "gateway",
    });
  });
});
