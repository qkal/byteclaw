import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLegacyWebFetchConfigPaths,
  migrateLegacyWebFetchConfig,
} from "./legacy-web-fetch-migrate.js";

describe("legacy web fetch config", () => {
  it("migrates legacy Firecrawl fetch config into plugin-owned config", () => {
    const res = migrateLegacyWebFetchConfig({
      tools: {
        web: {
          fetch: {
            firecrawl: {
              apiKey: "firecrawl-key",
              baseUrl: "https://api.firecrawl.dev",
              onlyMainContent: false,
            },
            provider: "firecrawl",
            timeoutSeconds: 15,
          },
        },
      },
    } as OpenClawConfig);

    expect(res.config.tools?.web?.fetch).toEqual({
      provider: "firecrawl",
      timeoutSeconds: 15,
    });
    expect(res.config.plugins?.entries?.firecrawl).toEqual({
      config: {
        webFetch: {
          apiKey: "firecrawl-key",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: false,
        },
      },
      enabled: true,
    });
    expect(res.changes).toEqual([
      "Moved tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch.",
    ]);
  });

  it("drops legacy firecrawl.enabled when migrating plugin-owned config", () => {
    const res = migrateLegacyWebFetchConfig({
      tools: {
        web: {
          fetch: {
            firecrawl: {
              apiKey: "firecrawl-key",
              enabled: false,
            },
            provider: "firecrawl",
          },
        },
      },
    } as OpenClawConfig);

    expect(res.config.plugins?.entries?.firecrawl).toEqual({
      config: {
        webFetch: {
          apiKey: "firecrawl-key",
        },
      },
      enabled: true,
    });
  });

  it("lists legacy Firecrawl fetch config paths", () => {
    expect(
      listLegacyWebFetchConfigPaths({
        tools: {
          web: {
            fetch: {
              firecrawl: {
                apiKey: "firecrawl-key",
                maxAgeMs: 123,
              },
            },
          },
        },
      }),
    ).toEqual(["tools.web.fetch.firecrawl.apiKey", "tools.web.fetch.firecrawl.maxAgeMs"]);
  });
});
