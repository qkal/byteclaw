import { describe, expect, it } from "vitest";
import {
  matchesApprovalRequestFilters,
  matchesApprovalRequestSessionFilter,
} from "./approval-request-filters.js";

describe("approval request filters", () => {
  it("matches explicit agent ids and session substrings", () => {
    expect(
      matchesApprovalRequestFilters({
        agentFilter: ["ops-agent"],
        request: {
          agentId: "ops-agent",
          sessionKey: "agent:ops-agent:slack:direct:U1:tail",
        },
        sessionFilter: ["slack:direct:", "tail$"],
      }),
    ).toBe(true);
  });

  it("can fall back to the session-key agent id", () => {
    expect(
      matchesApprovalRequestFilters({
        agentFilter: ["ops-agent"],
        fallbackAgentIdFromSessionKey: true,
        request: {
          sessionKey: "agent:ops-agent:telegram:group:-1001",
        },
      }),
    ).toBe(true);
    expect(
      matchesApprovalRequestFilters({
        agentFilter: ["ops-agent"],
        request: {
          sessionKey: "agent:ops-agent:telegram:group:-1001",
        },
      }),
    ).toBe(false);
  });

  it("rejects unsafe regex patterns in session filters", () => {
    expect(matchesApprovalRequestSessionFilter(`${"a".repeat(28)}!`, ["(a+)+$"])).toBe(false);
  });
});
