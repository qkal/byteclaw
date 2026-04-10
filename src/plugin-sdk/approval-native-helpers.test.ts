import { describe, expect, it } from "vitest";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "./approval-native-helpers.js";
import type { OpenClawConfig } from "./config-runtime.js";

describe("createChannelNativeOriginTargetResolver", () => {
  it("reuses shared turn-source routing and respects shouldHandle gating", () => {
    const resolveOriginTarget = createChannelNativeOriginTargetResolver({
      channel: "matrix",
      resolveSessionTarget: (sessionTarget) => ({
        threadId: sessionTarget.threadId,
        to: sessionTarget.to,
      }),
      resolveTurnSourceTarget: (request) => ({
        threadId: request.request.turnSourceThreadId ?? undefined,
        to: String(request.request.turnSourceTo),
      }),
      shouldHandleRequest: ({ accountId }) => accountId === "ops",
      targetsMatch: (a, b) => a.to === b.to && a.threadId === b.threadId,
    });

    expect(
      resolveOriginTarget({
        accountId: "ops",
        cfg: {} as OpenClawConfig,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "plugin:req-1",
          request: {
            description: "Allow access",
            title: "Plugin approval",
            turnSourceAccountId: "ops",
            turnSourceChannel: "matrix",
            turnSourceThreadId: "t1",
            turnSourceTo: "room:!room:example.org",
          },
        },
      }),
    ).toEqual({
      threadId: "t1",
      to: "room:!room:example.org",
    });

    expect(
      resolveOriginTarget({
        accountId: "other",
        cfg: {} as OpenClawConfig,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "plugin:req-1",
          request: {
            description: "Allow access",
            title: "Plugin approval",
            turnSourceAccountId: "ops",
            turnSourceChannel: "matrix",
            turnSourceThreadId: "t1",
            turnSourceTo: "room:!room:example.org",
          },
        },
      }),
    ).toBeNull();
  });
});

describe("createChannelApproverDmTargetResolver", () => {
  it("filters null targets and skips delivery when shouldHandle rejects the request", () => {
    const resolveApproverDmTargets = createChannelApproverDmTargetResolver({
      mapApprover: (approver) =>
        approver === "skip-me"
          ? null
          : {
              to: `user:${approver}`,
            },
      resolveApprovers: () => ["owner-1", "owner-2", "skip-me"],
      shouldHandleRequest: ({ approvalKind }) => approvalKind === "exec",
    });

    expect(
      resolveApproverDmTargets({
        accountId: "default",
        approvalKind: "exec",
        cfg: {},
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-1",
          request: { command: "echo hi" },
        },
      }),
    ).toEqual([{ to: "user:owner-1" }, { to: "user:owner-2" }]);

    expect(
      resolveApproverDmTargets({
        accountId: "default",
        approvalKind: "plugin",
        cfg: {},
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "plugin:req-1",
          request: { description: "Allow access", title: "Plugin approval" },
        },
      }),
    ).toEqual([]);
  });
});
