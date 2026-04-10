import { describe, expect, it } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { resolveChannelNativeApprovalDeliveryPlan } from "./approval-native-delivery.js";

const execRequest = {
  createdAtMs: 0,
  expiresAtMs: 120_000,
  id: "approval-1",
  request: {
    command: "uname -a",
  },
};

describe("resolveChannelNativeApprovalDeliveryPlan", () => {
  it("prefers the origin surface when configured and available", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "origin",
        supportsApproverDmSurface: true,
        supportsOriginSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }],
      resolveOriginTarget: async () => ({ threadId: "42", to: "origin-chat" }),
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      adapter,
      approvalKind: "exec",
      cfg: {} as never,
      request: execRequest,
    });

    expect(plan.notifyOriginWhenDmOnly).toBe(false);
    expect(plan.targets).toEqual([
      {
        reason: "preferred",
        surface: "origin",
        target: { threadId: "42", to: "origin-chat" },
      },
    ]);
  });

  it("falls back to approver DMs when origin delivery is unavailable", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "origin",
        supportsApproverDmSurface: true,
        supportsOriginSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
      resolveOriginTarget: async () => null,
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      adapter,
      approvalKind: "exec",
      cfg: {} as never,
      request: execRequest,
    });

    expect(plan.targets).toEqual([
      {
        reason: "fallback",
        surface: "approver-dm",
        target: { to: "approver-1" },
      },
      {
        reason: "fallback",
        surface: "approver-dm",
        target: { to: "approver-2" },
      },
    ]);
  });

  it("requests an origin redirect notice when DM-only delivery has an origin context", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        notifyOriginWhenDmOnly: true,
        preferredSurface: "approver-dm",
        supportsApproverDmSurface: true,
        supportsOriginSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }],
      resolveOriginTarget: async () => ({ to: "origin-chat" }),
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      adapter,
      approvalKind: "plugin",
      cfg: {} as never,
      request: {
        ...execRequest,
        id: "plugin:approval-1",
        request: {
          description: "Needs access",
          title: "Plugin approval",
        },
      },
    });

    expect(plan.originTarget).toEqual({ to: "origin-chat" });
    expect(plan.notifyOriginWhenDmOnly).toBe(true);
    expect(plan.targets).toEqual([
      {
        reason: "preferred",
        surface: "approver-dm",
        target: { to: "approver-1" },
      },
    ]);
  });

  it("dedupes duplicate origin and DM targets when both surfaces converge", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "both",
        supportsApproverDmSurface: true,
        supportsOriginSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "shared-chat" }, { to: "approver-2" }],
      resolveOriginTarget: async () => ({ to: "shared-chat" }),
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      adapter,
      approvalKind: "exec",
      cfg: {} as never,
      request: execRequest,
    });

    expect(plan.targets).toEqual([
      {
        reason: "preferred",
        surface: "origin",
        target: { to: "shared-chat" },
      },
      {
        reason: "preferred",
        surface: "approver-dm",
        target: { to: "approver-2" },
      },
    ]);
  });
});
