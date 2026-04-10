import { describe, expect, it } from "vitest";
import { resolveIdleProfileStopOutcome } from "./server-context.lifecycle.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";

describe("resolveIdleProfileStopOutcome", () => {
  it("treats attachOnly profiles as stopped via Playwright cleanup", () => {
    expect(resolveIdleProfileStopOutcome(makeBrowserProfile({ attachOnly: true }))).toEqual({
      closePlaywright: true,
      stopped: true,
    });
  });

  it("treats remote CDP profiles as stopped via Playwright cleanup", () => {
    expect(
      resolveIdleProfileStopOutcome(
        makeBrowserProfile({
          cdpHost: "10.0.0.5",
          cdpIsLoopback: false,
          cdpPort: 9222,
          cdpUrl: "http://10.0.0.5:9222",
        }),
      ),
    ).toEqual({
      closePlaywright: true,
      stopped: true,
    });
  });

  it("keeps never-started managed profiles as not stopped", () => {
    expect(resolveIdleProfileStopOutcome(makeBrowserProfile())).toEqual({
      closePlaywright: false,
      stopped: false,
    });
  });
});
