import { describe, expect, it } from "vitest";
import {
  shouldAllowCooldownProbeForReason,
  shouldPreserveTransientCooldownProbeSlot,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";

interface ReasonCase {
  reason: FailoverReason | null | undefined;
  allowCooldownProbe: boolean;
  useTransientProbeSlot: boolean;
  preserveTransientProbeSlot: boolean;
}

const CASES: ReasonCase[] = [
  {
    allowCooldownProbe: true,
    preserveTransientProbeSlot: false,
    reason: "rate_limit",
    useTransientProbeSlot: true,
  },
  {
    allowCooldownProbe: true,
    preserveTransientProbeSlot: false,
    reason: "overloaded",
    useTransientProbeSlot: true,
  },
  {
    allowCooldownProbe: true,
    preserveTransientProbeSlot: false,
    reason: "billing",
    useTransientProbeSlot: false,
  },
  {
    allowCooldownProbe: true,
    preserveTransientProbeSlot: false,
    reason: "unknown",
    useTransientProbeSlot: true,
  },
  {
    allowCooldownProbe: false,
    preserveTransientProbeSlot: true,
    reason: "model_not_found",
    useTransientProbeSlot: false,
  },
  {
    allowCooldownProbe: false,
    preserveTransientProbeSlot: true,
    reason: "format",
    useTransientProbeSlot: false,
  },
  {
    allowCooldownProbe: false,
    preserveTransientProbeSlot: true,
    reason: "auth",
    useTransientProbeSlot: false,
  },
  {
    allowCooldownProbe: false,
    preserveTransientProbeSlot: true,
    reason: "auth_permanent",
    useTransientProbeSlot: false,
  },
  {
    allowCooldownProbe: false,
    preserveTransientProbeSlot: true,
    reason: "session_expired",
    useTransientProbeSlot: false,
  },
  {
    allowCooldownProbe: true,
    preserveTransientProbeSlot: false,
    reason: "timeout",
    useTransientProbeSlot: true,
  },
  {
    allowCooldownProbe: false,
    preserveTransientProbeSlot: false,
    reason: null,
    useTransientProbeSlot: false,
  },
  {
    allowCooldownProbe: false,
    preserveTransientProbeSlot: false,
    reason: undefined,
    useTransientProbeSlot: false,
  },
];

describe("failover-policy", () => {
  it("maps failover reasons to cooldown-probe decisions", () => {
    for (const testCase of CASES) {
      expect(shouldAllowCooldownProbeForReason(testCase.reason)).toBe(testCase.allowCooldownProbe);
      expect(shouldUseTransientCooldownProbeSlot(testCase.reason)).toBe(
        testCase.useTransientProbeSlot,
      );
      expect(shouldPreserveTransientCooldownProbeSlot(testCase.reason)).toBe(
        testCase.preserveTransientProbeSlot,
      );
    }
  });
});
