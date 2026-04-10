import { describe, expect, it } from "vitest";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";

describe("security audit deep probe failure", () => {
  it("adds probe_failed warnings for deep probe failure modes", () => {
    const cases: {
      name: string;
      deep: {
        gateway: {
          attempted: boolean;
          url: string | null;
          ok: boolean;
          error: string | null;
          close?: { code: number; reason: string } | null;
        };
      };
      expectedError?: string;
    }[] = [
      {
        deep: {
          gateway: {
            attempted: true,
            close: null,
            error: "connect failed",
            ok: false,
            url: "ws://127.0.0.1:18789",
          },
        },
        expectedError: "connect failed",
        name: "probe returns failed result",
      },
      {
        deep: {
          gateway: {
            attempted: true,
            close: null,
            error: "probe boom",
            ok: false,
            url: "ws://127.0.0.1:18789",
          },
        },
        expectedError: "probe boom",
        name: "probe throws",
      },
    ];

    for (const testCase of cases) {
      const findings = collectDeepProbeFindings({ deep: testCase.deep });
      expect(
        findings.some((finding) => finding.checkId === "gateway.probe_failed"),
        testCase.name,
      ).toBe(true);
      expect(findings[0]?.detail).toContain(testCase.expectedError!);
    }
  });
});
