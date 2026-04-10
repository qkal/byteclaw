import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OAUTH_WARN_MS,
  buildAuthHealthSummary,
  formatRemainingShort,
} from "./auth-health.js";

describe("buildAuthHealthSummary", () => {
  const now = 1_700_000_000_000;
  const profileStatuses = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.status]));
  const profileReasonCodes = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.reasonCode]));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies OAuth and API key profiles", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      profiles: {
        "anthropic:api": {
          key: "sk-ant-api",
          provider: "anthropic",
          type: "api_key" as const,
        },
        "anthropic:expired": {
          access: "access",
          expires: now - 10_000,
          provider: "anthropic",
          refresh: "refresh",
          type: "oauth" as const,
        },
        "anthropic:expiring": {
          access: "access",
          expires: now + 10_000,
          provider: "anthropic",
          refresh: "refresh",
          type: "oauth" as const,
        },
        "anthropic:ok": {
          access: "access",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
          provider: "anthropic",
          refresh: "refresh",
          type: "oauth" as const,
        },
      },
      version: 1,
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["anthropic:ok"]).toBe("ok");
    // OAuth credentials with refresh tokens are auto-renewable, so they report "ok"
    expect(statuses["anthropic:expiring"]).toBe("ok");
    expect(statuses["anthropic:expired"]).toBe("ok");
    expect(statuses["anthropic:api"]).toBe("static");

    const provider = summary.providers.find((entry) => entry.provider === "anthropic");
    expect(provider?.status).toBe("ok");
  });

  it("reports expired for OAuth without a refresh token", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      profiles: {
        "google:no-refresh": {
          access: "access",
          expires: now - 10_000,
          provider: "google-antigravity",
          refresh: "",
          type: "oauth" as const,
        },
      },
      version: 1,
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["google:no-refresh"]).toBe("expired");
  });

  it("marks token profiles with invalid expires as missing with reason code", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      profiles: {
        "github-copilot:invalid-expires": {
          expires: 0,
          provider: "github-copilot",
          token: "gh-token",
          type: "token" as const,
        },
      },
      version: 1,
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });
    const statuses = profileStatuses(summary);
    const reasonCodes = profileReasonCodes(summary);

    expect(statuses["github-copilot:invalid-expires"]).toBe("missing");
    expect(reasonCodes["github-copilot:invalid-expires"]).toBe("invalid_expires");
  });

  it("normalizes provider aliases when filtering and grouping profile health", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      profiles: {
        "zai:dash": {
          key: "sk-dash",
          provider: "z-ai",
          type: "api_key" as const,
        },
        "zai:dot": {
          key: "sk-dot",
          provider: "z.ai",
          type: "api_key" as const,
        },
      },
      version: 1,
    };

    const summary = buildAuthHealthSummary({
      providers: ["zai"],
      store,
    });

    expect(summary.profiles.map((profile) => [profile.profileId, profile.provider])).toEqual([
      ["zai:dash", "zai"],
      ["zai:dot", "zai"],
    ]);
    expect(summary.providers).toEqual([
      {
        profiles: summary.profiles,
        provider: "zai",
        status: "static",
      },
    ]);
  });
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});
