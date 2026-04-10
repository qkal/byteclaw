import { describe, expect, it } from "vitest";
import { resolveAuthProfileDisplayLabel } from "./display.js";

describe("resolveAuthProfileDisplayLabel", () => {
  it("prefers displayName over email metadata", () => {
    const label = resolveAuthProfileDisplayLabel({
      cfg: {
        auth: {
          profiles: {
            "openai-codex:id-abc": {
              displayName: "Work account",
              email: "work@example.com",
              mode: "oauth",
              provider: "openai-codex",
            },
          },
        },
      },
      profileId: "openai-codex:id-abc",
      store: { profiles: {}, version: 1 },
    });

    expect(label).toBe("openai-codex:id-abc (Work account)");
  });

  it("does not synthesize bogus labels when no human metadata exists", () => {
    const label = resolveAuthProfileDisplayLabel({
      profileId: "openai-codex:id-abc",
      store: {
        profiles: {
          "openai-codex:id-abc": {
            access: "token",
            expires: Date.now() + 60_000,
            provider: "openai-codex",
            refresh: "refresh-token",
            type: "oauth",
          },
        },
        version: 1,
      },
    });

    expect(label).toBe("openai-codex:id-abc");
  });
});
