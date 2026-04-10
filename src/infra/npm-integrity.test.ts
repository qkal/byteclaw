import { describe, expect, it, vi } from "vitest";
import {
  resolveNpmIntegrityDrift,
  resolveNpmIntegrityDriftWithDefaultMessage,
} from "./npm-integrity.js";

describe("resolveNpmIntegrityDrift", () => {
  it.each([
    {
      expectedIntegrity: undefined,
      resolution: { integrity: "sha512-same", resolvedAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      expectedIntegrity: "sha512-same",
      resolution: { resolvedAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      expectedIntegrity: "sha512-same",
      resolution: { integrity: "sha512-same", resolvedAt: "2026-01-01T00:00:00.000Z" },
    },
  ])(
    "returns proceed=true when integrity is missing or unchanged: $expectedIntegrity",
    async ({ expectedIntegrity, resolution }) => {
      const createPayload = vi.fn(() => "unused");
      await expect(
        resolveNpmIntegrityDrift({
          createPayload,
          expectedIntegrity,
          resolution,
          spec: "@openclaw/test@1.0.0",
        }),
      ).resolves.toEqual({ proceed: true });
      expect(createPayload).not.toHaveBeenCalled();
    },
  );

  it("uses callback on integrity drift", async () => {
    const onIntegrityDrift = vi.fn(async () => false);
    const result = await resolveNpmIntegrityDrift({
      createPayload: ({ expectedIntegrity, actualIntegrity }) => ({
        actualIntegrity,
        expectedIntegrity,
      }),
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      spec: "@openclaw/test@1.0.0",
    });

    expect(onIntegrityDrift).toHaveBeenCalledWith({
      actualIntegrity: "sha512-new",
      expectedIntegrity: "sha512-old",
    });
    expect(result.proceed).toBe(false);
    expect(result.integrityDrift).toEqual({
      actualIntegrity: "sha512-new",
      expectedIntegrity: "sha512-old",
    });
  });

  it("returns payload when the drift callback allows continuing", async () => {
    const result = await resolveNpmIntegrityDrift({
      createPayload: ({ spec, actualIntegrity }) => ({ actualIntegrity, spec }),
      expectedIntegrity: "sha512-old",
      onIntegrityDrift: async () => true,
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      spec: "@openclaw/test@1.0.0",
    });

    expect(result).toEqual({
      integrityDrift: {
        actualIntegrity: "sha512-new",
        expectedIntegrity: "sha512-old",
      },
      payload: {
        actualIntegrity: "sha512-new",
        spec: "@openclaw/test@1.0.0",
      },
      proceed: true,
    });
  });

  it("warns by default when no callback is provided", async () => {
    const warn = vi.fn();
    const result = await resolveNpmIntegrityDrift({
      createPayload: ({ spec }) => ({ spec }),
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      spec: "@openclaw/test@1.0.0",
      warn,
    });

    expect(warn).toHaveBeenCalledWith({ spec: "@openclaw/test@1.0.0" });
    expect(result.proceed).toBe(true);
  });

  it("formats default warning and abort error messages", async () => {
    const warn = vi.fn();
    const warningResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
        resolvedSpec: "@openclaw/test@1.0.0",
      },
      spec: "@openclaw/test@1.0.0",
      warn,
    });
    expect(warningResult.error).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );

    const abortResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      expectedIntegrity: "sha512-old",
      onIntegrityDrift: async () => false,
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
        resolvedSpec: "@openclaw/test@1.0.0",
      },
      spec: "@openclaw/test@1.0.0",
    });
    expect(abortResult.error).toBe(
      "aborted: npm package integrity drift detected for @openclaw/test@1.0.0",
    );
  });

  it("falls back to the original spec when resolvedSpec is missing", async () => {
    const warn = vi.fn();

    await resolveNpmIntegrityDriftWithDefaultMessage({
      expectedIntegrity: "sha512-old",
      resolution: {
        integrity: "sha512-new",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      spec: "@openclaw/test@1.0.0",
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      "Integrity drift detected for @openclaw/test@1.0.0: expected sha512-old, got sha512-new",
    );
  });
});
