import { describe, expect, it } from "vitest";
import { enablePluginInConfig as enableFetchPluginInConfig } from "./provider-web-fetch-contract.js";
import { enablePluginInConfig as enableSearchPluginInConfig } from "./provider-web-search-contract.js";

describe("provider contract enablePluginInConfig", () => {
  it("enables and allowlists provider plugins without touching channels", () => {
    const config = {
      channels: {
        brave: { enabled: false },
      },
      plugins: {
        allow: ["openai"],
      },
    };

    const result = enableSearchPluginInConfig(config, "brave");

    expect(result).toEqual({
      config: {
        channels: {
          brave: { enabled: false },
        },
        plugins: {
          allow: ["openai", "brave"],
          entries: {
            brave: { enabled: true },
          },
        },
      },
      enabled: true,
    });
  });

  it("shares denylist behavior across provider contract subpaths", () => {
    const config = {
      plugins: {
        deny: ["firecrawl"],
      },
    };

    expect(enableFetchPluginInConfig(config, "firecrawl")).toEqual({
      config,
      enabled: false,
      reason: "blocked by denylist",
    });
  });
});
