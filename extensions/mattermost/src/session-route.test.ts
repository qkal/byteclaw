import { describe, expect, it } from "vitest";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";

describe("mattermost session route", () => {
  it("builds direct-message routes for user targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      accountId: "acct-1",
      agentId: "main",
      cfg: {},
      target: "@user123",
    });

    expect(route).toMatchObject({
      from: "mattermost:user123",
      peer: {
        id: "user123",
        kind: "direct",
      },
      to: "user:user123",
    });
  });

  it("builds threaded channel routes for channel targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      accountId: "acct-1",
      agentId: "main",
      cfg: {},
      target: "mattermost:channel:chan123",
      threadId: "thread456",
    });

    expect(route).toMatchObject({
      from: "mattermost:channel:chan123",
      peer: {
        id: "chan123",
        kind: "channel",
      },
      threadId: "thread456",
      to: "channel:chan123",
    });
    expect(route?.sessionKey).toContain("thread456");
  });

  it("returns null when the target is empty after normalization", () => {
    expect(
      resolveMattermostOutboundSessionRoute({
        accountId: "acct-1",
        agentId: "main",
        cfg: {},
        target: "mattermost:",
      }),
    ).toBeNull();
  });
});
