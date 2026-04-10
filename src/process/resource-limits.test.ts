import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESOURCE_LIMITS,
  applyResourceLimits,
  getResourceLimits,
  type ResourceLimits,
} from "./resource-limits.js";

describe("resource-limits", () => {
  describe("applyResourceLimits", () => {
    it("applies memory limits", () => {
      const options = {};
      const limits: ResourceLimits = { maxMemoryMB: 512 };
      const result = applyResourceLimits(options, limits);
      expect(result.resourceLimits).toBeDefined();
      expect((result.resourceLimits as Record<string, unknown>).maxRSS).toBe(
        512 * 1024 * 1024,
      );
    });

    it("applies CPU time limits", () => {
      const options = {};
      const limits: ResourceLimits = { maxCpuTimeMs: 30000 };
      const result = applyResourceLimits(options, limits);
      expect(result.resourceLimits).toBeDefined();
      expect((result.resourceLimits as Record<string, unknown>).maxCPU).toBe(30);
    });

    it("applies multiple limits", () => {
      const options = {};
      const limits: ResourceLimits = {
        maxMemoryMB: 512,
        maxCpuTimeMs: 30000,
      };
      const result = applyResourceLimits(options, limits);
      expect(result.resourceLimits).toBeDefined();
    });

    it("preserves existing options", () => {
      const options = { cwd: "/tmp" };
      const limits: ResourceLimits = { maxMemoryMB: 512 };
      const result = applyResourceLimits(options, limits);
      expect(result.cwd).toBe("/tmp");
    });
  });

  describe("getResourceLimits", () => {
    it("returns shortLived limits", () => {
      const limits = getResourceLimits("shortLived");
      expect(limits.maxMemoryMB).toBe(512);
      expect(limits.maxCpuTimeMs).toBe(30000);
    });

    it("returns mediumLived limits by default", () => {
      const limits = getResourceLimits("mediumLived" as any);
      expect(limits.maxMemoryMB).toBe(1024);
    });

    it("has defined default limits", () => {
      expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty("shortLived");
      expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty("mediumLived");
      expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty("longLived");
    });
  });
});
