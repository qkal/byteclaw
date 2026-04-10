import { describe, expect, it } from "vitest";
import {
  isBun,
  isNode,
  getRuntime,
  getRuntimeVersion,
  withRuntimeContext,
  getForcedRuntime,
  getEffectiveRuntime,
} from "./runtime-detection.js";

describe("runtime-detection", () => {
  describe("isBun", () => {
    it("returns boolean", () => {
      expect(typeof isBun()).toBe("boolean");
    });
  });

  describe("isNode", () => {
    it("returns boolean", () => {
      expect(typeof isNode()).toBe("boolean");
    });

    it("is opposite of isBun", () => {
      expect(isNode()).toBe(!isBun());
    });
  });

  describe("getRuntime", () => {
    it("returns bun or node", () => {
      expect(getRuntime()).toMatch(/^(bun|node)$/);
    });

    it("matches isBun", () => {
      expect(getRuntime() === "bun").toBe(isBun());
    });
  });

  describe("getRuntimeVersion", () => {
    it("returns string", () => {
      expect(typeof getRuntimeVersion()).toBe("string");
    });

    it("returns non-empty string", () => {
      expect(getRuntimeVersion().length).toBeGreaterThan(0);
    });
  });

  describe("withRuntimeContext", () => {
    it("prepends runtime info to message", () => {
      const message = "test message";
      const result = withRuntimeContext(message);
      expect(result).toMatch(/\[bun|node/);
      expect(result).toContain(message);
    });
  });

  describe("getForcedRuntime", () => {
    it("returns null when OPENCLAW_RUNTIME not set", () => {
      delete process.env.OPENCLAW_RUNTIME;
      expect(getForcedRuntime()).toBeNull();
    });

    it("returns bun when OPENCLAW_RUNTIME=bun", () => {
      process.env.OPENCLAW_RUNTIME = "bun";
      expect(getForcedRuntime()).toBe("bun");
      delete process.env.OPENCLAW_RUNTIME;
    });

    it("returns node when OPENCLAW_RUNTIME=node", () => {
      process.env.OPENCLAW_RUNTIME = "node";
      expect(getForcedRuntime()).toBe("node");
      delete process.env.OPENCLAW_RUNTIME;
    });

    it("returns null for invalid values", () => {
      process.env.OPENCLAW_RUNTIME = "invalid";
      expect(getForcedRuntime()).toBeNull();
      delete process.env.OPENCLAW_RUNTIME;
    });
  });

  describe("getEffectiveRuntime", () => {
    it("returns detected runtime when not forced", () => {
      delete process.env.OPENCLAW_RUNTIME;
      expect(getEffectiveRuntime()).toBe(getRuntime());
    });

    it("returns forced runtime when set", () => {
      process.env.OPENCLAW_RUNTIME = "node";
      const result = getEffectiveRuntime();
      expect(result).toBe("node");
      delete process.env.OPENCLAW_RUNTIME;
    });
  });
});
