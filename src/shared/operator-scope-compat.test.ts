import { describe, expect, it } from "vitest";
import {
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "./operator-scope-compat.js";

describe("roleScopesAllow", () => {
  it("allows empty requested scope lists regardless of granted scopes", () => {
    expect(
      roleScopesAllow({
        allowedScopes: [],
        requestedScopes: [],
        role: "operator",
      }),
    ).toBe(true);
  });

  it("treats operator.read as satisfied by read/write/admin scopes", () => {
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.read"],
        requestedScopes: ["operator.read"],
        role: "operator",
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.write"],
        requestedScopes: ["operator.read"],
        role: "operator",
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.admin"],
        requestedScopes: ["operator.read"],
        role: "operator",
      }),
    ).toBe(true);
  });

  it("treats operator.write as satisfied by write/admin scopes", () => {
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.write"],
        requestedScopes: ["operator.write"],
        role: "operator",
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.admin"],
        requestedScopes: ["operator.write"],
        role: "operator",
      }),
    ).toBe(true);
  });

  it("treats operator.approvals/operator.pairing as satisfied by operator.admin", () => {
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.admin"],
        requestedScopes: ["operator.approvals"],
        role: "operator",
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.admin"],
        requestedScopes: ["operator.pairing"],
        role: "operator",
      }),
    ).toBe(true);
  });

  it("does not treat operator.admin as satisfying non-operator scopes", () => {
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.admin"],
        requestedScopes: ["system.run"],
        role: "operator",
      }),
    ).toBe(false);
  });

  it("uses strict matching with role-prefix partitioning for non-operator roles", () => {
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.admin", "node.exec"],
        requestedScopes: ["node.exec"],
        role: "node",
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.admin"],
        requestedScopes: ["node.exec"],
        role: "node",
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.read", "node.exec"],
        requestedScopes: ["operator.read"],
        role: "node",
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        allowedScopes: ["node.exec", "operator.admin"],
        requestedScopes: [" node.exec ", "node.exec", "  "],
        role: " node ",
      }),
    ).toBe(true);
  });

  it("normalizes blank and duplicate scopes before evaluating", () => {
    expect(
      roleScopesAllow({
        allowedScopes: [" operator.write ", "operator.write", ""],
        requestedScopes: [" operator.read ", "operator.read", "   "],
        role: " operator ",
      }),
    ).toBe(true);
  });

  it("rejects unsatisfied operator write scopes and empty allowed scopes", () => {
    expect(
      roleScopesAllow({
        allowedScopes: ["operator.read"],
        requestedScopes: ["operator.write"],
        role: "operator",
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        allowedScopes: ["   "],
        requestedScopes: ["operator.read"],
        role: "operator",
      }),
    ).toBe(false);
  });

  it("returns the first missing requested scope with operator compatibility", () => {
    expect(
      resolveMissingRequestedScope({
        allowedScopes: ["operator.write"],
        requestedScopes: ["operator.read", "operator.write", "operator.approvals"],
        role: "operator",
      }),
    ).toBe("operator.approvals");
  });

  it("returns null when all requested scopes are satisfied", () => {
    expect(
      resolveMissingRequestedScope({
        allowedScopes: ["node.exec", "operator.admin"],
        requestedScopes: ["node.exec"],
        role: "node",
      }),
    ).toBeNull();
  });

  it("returns null when every requested scope belongs to one requested role", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["node.exec", "operator.read"],
      }),
    ).toBeNull();
  });

  it("returns the first scope outside the requested role set", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["node.exec", "vault.admin", "operator.read"],
      }),
    ).toBe("vault.admin");
  });
});
