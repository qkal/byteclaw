import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { resolveSnapshotPlan } from "./agent.snapshot.plan.js";

describe("resolveSnapshotPlan", () => {
  it("defaults existing-session snapshots to ai when format is omitted", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        user: { attachOnly: true, color: "#00AA00", driver: "existing-session" },
      },
    });
    const profile = resolveProfile(resolved, "user");
    expect(profile).toBeTruthy();
    expect(profile?.driver).toBe("existing-session");

    const plan = resolveSnapshotPlan({
      hasPlaywright: true,
      profile: profile as NonNullable<typeof profile>,
      query: {},
    });

    expect(plan.format).toBe("ai");
  });

  it("keeps ai snapshots for managed browsers when Playwright is available", () => {
    const resolved = resolveBrowserConfig({});
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile).toBeTruthy();

    const plan = resolveSnapshotPlan({
      hasPlaywright: true,
      profile: profile as NonNullable<typeof profile>,
      query: {},
    });

    expect(plan.format).toBe("ai");
  });
});
