import { expect, it } from "vitest";

type ResolveTargetMode = "explicit" | "implicit" | "heartbeat";

interface ResolveTargetResult {
  ok: boolean;
  to?: string;
  error?: unknown;
}

type ResolveTargetFn = (params: {
  to?: string;
  mode: ResolveTargetMode;
  allowFrom: string[];
}) => ResolveTargetResult;

export function installCommonResolveTargetErrorCases(params: {
  resolveTarget: ResolveTargetFn;
  implicitAllowFrom: string[];
}) {
  const { resolveTarget, implicitAllowFrom } = params;

  it("should error on normalization failure with allowlist (implicit mode)", () => {
    const result = resolveTarget({
      allowFrom: implicitAllowFrom,
      mode: "implicit",
      to: "invalid-target",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should error when no target provided with allowlist", () => {
    const result = resolveTarget({
      allowFrom: implicitAllowFrom,
      mode: "implicit",
      to: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should error when no target and no allowlist", () => {
    const result = resolveTarget({
      allowFrom: [],
      mode: "explicit",
      to: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should handle whitespace-only target", () => {
    const result = resolveTarget({
      allowFrom: [],
      mode: "explicit",
      to: "   ",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
}
