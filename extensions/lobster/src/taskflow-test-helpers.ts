import { vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";

export type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["taskFlow"]["bindSession"]
>;

export function createFakeTaskFlow(overrides?: Partial<BoundTaskFlow>): BoundTaskFlow {
  const baseFlow = {
    controllerId: "tests/lobster",
    flowId: "flow-1",
    goal: "Run Lobster workflow",
    ownerKey: "agent:main:main",
    revision: 1,
    status: "running" as const,
    syncMode: "managed" as const,
  };

  return {
    cancel: vi.fn(),
    createManaged: vi.fn().mockReturnValue(baseFlow),
    fail: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "failed" as const },
    })),
    findLatest: vi.fn(),
    finish: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "completed" as const },
    })),
    get: vi.fn(),
    getTaskSummary: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    requestCancel: vi.fn(),
    resolve: vi.fn(),
    resume: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "running" as const },
    })),
    runTask: vi.fn(),
    sessionKey: "agent:main:main",
    setWaiting: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "waiting" as const },
    })),
    ...overrides,
  };
}
