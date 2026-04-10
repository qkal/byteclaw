import { beforeEach, describe, expect, it } from "vitest";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "./task-flow-owner-access.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";

beforeEach(() => {
  resetTaskFlowRegistryForTests();
});
describe("task flow owner access", () => {
  it("returns owner-scoped flows for direct and owner-key lookups", () => {
    const older = createManagedTaskFlow({
      controllerId: "tests/owner-access",
      createdAt: 100,
      goal: "Older flow",
      ownerKey: "agent:main:main",
      updatedAt: 100,
    });
    const latest = createManagedTaskFlow({
      controllerId: "tests/owner-access",
      createdAt: 200,
      goal: "Latest flow",
      ownerKey: "agent:main:main",
      updatedAt: 200,
    });

    expect(
      getTaskFlowByIdForOwner({
        callerOwnerKey: "agent:main:main",
        flowId: older.flowId,
      })?.flowId,
    ).toBe(older.flowId);
    expect(
      findLatestTaskFlowForOwner({
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(latest.flowId);
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        callerOwnerKey: "agent:main:main",
        token: "agent:main:main",
      })?.flowId,
    ).toBe(latest.flowId);
    expect(
      listTaskFlowsForOwner({
        callerOwnerKey: "agent:main:main",
      }).map((flow) => flow.flowId),
    ).toEqual([latest.flowId, older.flowId]);
  });

  it("denies cross-owner flow reads", () => {
    const flow = createManagedTaskFlow({
      controllerId: "tests/owner-access",
      goal: "Hidden flow",
      ownerKey: "agent:main:main",
    });

    expect(
      getTaskFlowByIdForOwner({
        callerOwnerKey: "agent:main:other",
        flowId: flow.flowId,
      }),
    ).toBeUndefined();
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        callerOwnerKey: "agent:main:other",
        token: flow.flowId,
      }),
    ).toBeUndefined();
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        callerOwnerKey: "agent:main:other",
        token: "agent:main:main",
      }),
    ).toBeUndefined();
    expect(
      listTaskFlowsForOwner({
        callerOwnerKey: "agent:main:other",
      }),
    ).toEqual([]);
  });
});
