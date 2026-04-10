import { describe, expect, it } from "vitest";
import { collectBlueBubblesStatusIssues } from "./status-issues.js";

describe("collectBlueBubblesStatusIssues", () => {
  it("reports unconfigured enabled accounts", () => {
    const issues = collectBlueBubblesStatusIssues([
      {
        accountId: "default",
        configured: false,
        enabled: true,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        accountId: "default",
        channel: "bluebubbles",
        kind: "config",
      }),
    ]);
  });

  it("reports probe failure and runtime error for configured running accounts", () => {
    const issues = collectBlueBubblesStatusIssues([
      {
        accountId: "work",
        configured: true,
        enabled: true,
        lastError: "timeout",
        probe: {
          ok: false,
          status: 503,
        },
        running: true,
      },
    ]);

    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual(
      expect.objectContaining({
        accountId: "work",
        channel: "bluebubbles",
        kind: "runtime",
      }),
    );
    expect(issues[1]).toEqual(
      expect.objectContaining({
        accountId: "work",
        channel: "bluebubbles",
        kind: "runtime",
        message: "Channel error: timeout",
      }),
    );
  });
});
