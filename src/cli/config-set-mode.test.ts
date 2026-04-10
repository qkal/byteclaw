import { describe, expect, it } from "vitest";
import { resolveConfigSetMode } from "./config-set-parser.js";

describe("resolveConfigSetMode", () => {
  it("selects value mode by default", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasProviderBuilderOptions: false,
      hasRefBuilderOptions: false,
      strictJson: false,
    });
    expect(result).toEqual({ mode: "value", ok: true });
  });

  it("selects json mode when strict parsing is enabled", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasProviderBuilderOptions: false,
      hasRefBuilderOptions: false,
      strictJson: true,
    });
    expect(result).toEqual({ mode: "json", ok: true });
  });

  it("selects ref-builder mode when ref flags are present", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasProviderBuilderOptions: false,
      hasRefBuilderOptions: true,
      strictJson: false,
    });
    expect(result).toEqual({ mode: "ref_builder", ok: true });
  });

  it("selects provider-builder mode when provider flags are present", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasProviderBuilderOptions: true,
      hasRefBuilderOptions: false,
      strictJson: false,
    });
    expect(result).toEqual({ mode: "provider_builder", ok: true });
  });

  it("returns batch mode when batch flags are present", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: true,
      hasProviderBuilderOptions: false,
      hasRefBuilderOptions: false,
      strictJson: false,
    });
    expect(result).toEqual({ mode: "batch", ok: true });
  });

  it("rejects ref-builder and provider-builder collisions", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasProviderBuilderOptions: true,
      hasRefBuilderOptions: true,
      strictJson: false,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining("choose exactly one mode"),
    });
  });

  it("rejects mixing batch mode with builder flags", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: true,
      hasProviderBuilderOptions: false,
      hasRefBuilderOptions: true,
      strictJson: false,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining("batch mode (--batch-json/--batch-file) cannot be combined"),
    });
  });
});
