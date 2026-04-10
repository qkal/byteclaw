import { vi } from "vitest";

const noop = () => {};
const sharedMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({
    endedAt: 222,
    startedAt: 111,
    status: "ok" as const,
  })),
  onAgentEvent: vi.fn(() => noop),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: sharedMocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: sharedMocks.onAgentEvent,
}));
