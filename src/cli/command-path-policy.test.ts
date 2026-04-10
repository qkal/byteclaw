import { describe, expect, it } from "vitest";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

describe("command-path-policy", () => {
  it("resolves status policy with shared startup semantics", () => {
    expect(resolveCliCommandPathPolicy(["status"])).toEqual({
      bypassConfigGuard: false,
      ensureCliPath: false,
      hideBanner: false,
      loadPlugins: "text-only",
      routeConfigGuard: "when-suppressed",
    });
  });

  it("applies exact overrides after broader channel plugin rules", () => {
    expect(resolveCliCommandPathPolicy(["channels", "send"])).toEqual({
      bypassConfigGuard: false,
      ensureCliPath: true,
      hideBanner: false,
      loadPlugins: "always",
      routeConfigGuard: "never",
    });
    expect(resolveCliCommandPathPolicy(["channels", "add"])).toEqual({
      bypassConfigGuard: false,
      ensureCliPath: true,
      hideBanner: false,
      loadPlugins: "never",
      routeConfigGuard: "never",
    });
  });

  it("resolves mixed startup-only rules", () => {
    expect(resolveCliCommandPathPolicy(["config", "validate"])).toEqual({
      bypassConfigGuard: true,
      ensureCliPath: true,
      hideBanner: false,
      loadPlugins: "never",
      routeConfigGuard: "never",
    });
    expect(resolveCliCommandPathPolicy(["gateway", "status"])).toEqual({
      bypassConfigGuard: false,
      ensureCliPath: true,
      hideBanner: false,
      loadPlugins: "never",
      routeConfigGuard: "always",
    });
    expect(resolveCliCommandPathPolicy(["plugins", "update"])).toEqual({
      bypassConfigGuard: false,
      ensureCliPath: true,
      hideBanner: true,
      loadPlugins: "never",
      routeConfigGuard: "never",
    });
    expect(resolveCliCommandPathPolicy(["cron", "list"])).toEqual({
      bypassConfigGuard: true,
      ensureCliPath: true,
      hideBanner: false,
      loadPlugins: "never",
      routeConfigGuard: "never",
    });
  });
});
