import fs from "node:fs";
import AjvPkg from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIFFS_PLUGIN_SECURITY,
  DEFAULT_DIFFS_TOOL_DEFAULTS,
  diffsPluginConfigSchema,
  resolveDiffImageRenderOptions,
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  resolveDiffsPluginViewerBaseUrl,
} from "./config.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";
import {
  VIEWER_LOADER_PATH,
  VIEWER_RUNTIME_PATH,
  getServedViewerAsset,
  resolveViewerRuntimeFileUrl,
} from "./viewer-assets.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

const FULL_DEFAULTS = {
  background: false,
  diffIndicators: "classic",
  fileFormat: "pdf",
  fileMaxWidth: 1280,
  fileQuality: "hq",
  fileScale: 2.6,
  fontFamily: "JetBrains Mono",
  fontSize: 17,
  layout: "split",
  lineSpacing: 1.8,
  mode: "file",
  showLineNumbers: false,
  theme: "light",
  wordWrap: false,
} as const;

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  return ajv.compile(manifest.configSchema);
}

describe("resolveDiffsPluginDefaults", () => {
  it("returns built-in defaults when config is missing", () => {
    expect(resolveDiffsPluginDefaults(undefined)).toEqual(DEFAULT_DIFFS_TOOL_DEFAULTS);
  });

  it("applies configured defaults from plugin config", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: FULL_DEFAULTS,
      }),
    ).toEqual(FULL_DEFAULTS);
  });

  it("clamps and falls back for invalid line spacing and indicators", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          diffIndicators: "unknown",
          lineSpacing: -5,
        },
      }),
    ).toMatchObject({
      diffIndicators: "bars",
      lineSpacing: 1,
    });

    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: 9,
        },
      }),
    ).toMatchObject({
      lineSpacing: 3,
    });

    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: Number.NaN,
        },
      }),
    ).toMatchObject({
      lineSpacing: DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing,
    });
  });

  it("derives file defaults from quality preset and clamps explicit overrides", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fileQuality: "print",
        },
      }),
    ).toMatchObject({
      fileMaxWidth: 1400,
      fileQuality: "print",
      fileScale: 3,
    });

    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fileMaxWidth: 99_999,
          fileQuality: "hq",
          fileScale: 99,
        },
      }),
    ).toMatchObject({
      fileMaxWidth: 2400,
      fileQuality: "hq",
      fileScale: 4,
    });
  });

  it("falls back to png for invalid file format defaults", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          fileFormat: "invalid" as "png",
        },
      }),
    ).toMatchObject({
      fileFormat: "png",
    });
  });

  it("resolves file render format from defaults and explicit overrides", () => {
    const defaults = resolveDiffsPluginDefaults({
      defaults: {
        fileFormat: "pdf",
      },
    });

    expect(resolveDiffImageRenderOptions({ defaults }).format).toBe("pdf");
    expect(resolveDiffImageRenderOptions({ defaults, fileFormat: "png" }).format).toBe("png");
    expect(resolveDiffImageRenderOptions({ defaults, format: "png" }).format).toBe("png");
  });

  it("accepts format as a config alias for fileFormat", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          format: "pdf",
        },
      }),
    ).toMatchObject({
      fileFormat: "pdf",
    });
  });

  it("accepts image* config aliases for backward compatibility", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          imageFormat: "pdf",
          imageMaxWidth: 1024,
          imageQuality: "hq",
          imageScale: 2.2,
        },
      }),
    ).toMatchObject({
      fileFormat: "pdf",
      fileMaxWidth: 1024,
      fileQuality: "hq",
      fileScale: 2.2,
    });
  });

  it("keeps loader-applied schema defaults from shadowing aliases and quality-derived defaults", () => {
    const validate = compileManifestConfigSchema();

    const aliasOnly = {
      defaults: {
        format: "pdf",
        imageQuality: "hq",
      },
    };
    expect(validate(aliasOnly)).toBe(true);
    expect(resolveDiffsPluginDefaults(aliasOnly)).toMatchObject({
      fileFormat: "pdf",
      fileMaxWidth: 1200,
      fileQuality: "hq",
      fileScale: 2.5,
    });

    const qualityOnly = {
      defaults: {
        fileQuality: "hq",
      },
    };
    expect(validate(qualityOnly)).toBe(true);
    expect(resolveDiffsPluginDefaults(qualityOnly)).toMatchObject({
      fileMaxWidth: 1200,
      fileQuality: "hq",
      fileScale: 2.5,
    });
  });
});

describe("resolveDiffsPluginSecurity", () => {
  it("defaults to local-only viewer access", () => {
    expect(resolveDiffsPluginSecurity(undefined)).toEqual(DEFAULT_DIFFS_PLUGIN_SECURITY);
  });

  it("allows opt-in remote viewer access", () => {
    expect(resolveDiffsPluginSecurity({ security: { allowRemoteViewer: true } })).toEqual({
      allowRemoteViewer: true,
    });
  });
});

describe("resolveDiffsPluginViewerBaseUrl", () => {
  it("defaults to undefined when config is missing", () => {
    expect(resolveDiffsPluginViewerBaseUrl(undefined)).toBeUndefined();
  });

  it("normalizes configured viewer base URLs", () => {
    expect(
      resolveDiffsPluginViewerBaseUrl({
        viewerBaseUrl: "https://example.com/openclaw/",
      }),
    ).toBe("https://example.com/openclaw");
  });
});

describe("diffs plugin schema surfaces", () => {
  it("rejects invalid viewerBaseUrl values at manifest-validation time too", () => {
    const validate = compileManifestConfigSchema();

    expect(validate({ viewerBaseUrl: "javascript:alert(1)" })).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw?x=1" })).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw#frag" })).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw/" })).toBe(true);
  });

  it("preserves defaults and security for direct safeParse callers", () => {
    expect(
      diffsPluginConfigSchema.safeParse?.({
        defaults: {
          theme: "light",
        },
        security: {
          allowRemoteViewer: true,
        },
        viewerBaseUrl: "https://example.com/openclaw/",
      }),
    ).toMatchObject({
      data: {
        defaults: {
          background: true,
          diffIndicators: "bars",
          fileFormat: "png",
          fileMaxWidth: 960,
          fileQuality: "standard",
          fileScale: 2,
          fontFamily: "Fira Code",
          fontSize: 15,
          layout: "unified",
          lineSpacing: 1.6,
          mode: "both",
          showLineNumbers: true,
          theme: "light",
          wordWrap: true,
        },
        security: {
          allowRemoteViewer: true,
        },
        viewerBaseUrl: "https://example.com/openclaw",
      },
      success: true,
    });
  });

  it("canonicalizes alias-driven defaults for direct safeParse callers", () => {
    expect(
      diffsPluginConfigSchema.safeParse?.({
        defaults: {
          format: "pdf",
          imageQuality: "hq",
        },
      }),
    ).toMatchObject({
      data: {
        defaults: {
          fileFormat: "pdf",
          fileMaxWidth: 1200,
          fileQuality: "hq",
          fileScale: 2.5,
        },
      },
      success: true,
    });
  });

  it("rejects invalid viewerBaseUrl config values", () => {
    expect(
      diffsPluginConfigSchema.safeParse?.({
        viewerBaseUrl: "javascript:alert(1)",
      }),
    ).toMatchObject({
      error: {
        issues: [
          {
            message: "viewerBaseUrl must use http or https: javascript:alert(1)",
            path: ["viewerBaseUrl"],
          },
        ],
      },
      success: false,
    });
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(diffsPluginConfigSchema.jsonSchema).toEqual(manifest.configSchema);
  });
});

describe("diffs viewer URL helpers", () => {
  it("defaults to loopback for lan/tailnet bind modes", () => {
    expect(
      buildViewerUrl({
        config: { gateway: { bind: "lan", port: 18_789 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:18789/plugins/diffs/view/id/token");

    expect(
      buildViewerUrl({
        config: { gateway: { bind: "tailnet", port: 24_444 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:24444/plugins/diffs/view/id/token");
  });

  it("uses custom bind host when provided", () => {
    expect(
      buildViewerUrl({
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.example.com",
            port: 443,
            tls: { enabled: true },
          },
        },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://gateway.example.com/plugins/diffs/view/id/token");
  });

  it("joins viewer path under baseUrl pathname", () => {
    expect(
      buildViewerUrl({
        baseUrl: "https://example.com/openclaw",
        config: {},
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://example.com/openclaw/plugins/diffs/view/id/token");
  });

  it("prefers normalized viewerBaseUrl strings too", () => {
    expect(
      buildViewerUrl({
        baseUrl: "https://example.com/openclaw/",
        config: {},
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://example.com/openclaw/plugins/diffs/view/id/token");
  });

  it("rejects base URLs with query/hash", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1")).toThrow(
      "baseUrl must not include query/hash",
    );
    expect(() => normalizeViewerBaseUrl("https://example.com#frag")).toThrow(
      "baseUrl must not include query/hash",
    );
  });

  it("uses the configured field name in viewerBaseUrl validation errors", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1", "viewerBaseUrl")).toThrow(
      "viewerBaseUrl must not include query/hash",
    );
  });
});

describe("viewer assets", () => {
  it("prefers the built plugin asset layout when present", async () => {
    const stat = vi.fn(async (path: string) => {
      if (path === "/repo/dist/extensions/diffs/assets/viewer-runtime.js") {
        return { mtimeMs: 1 };
      }
      const error = Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      throw error;
    });

    await expect(
      resolveViewerRuntimeFileUrl({
        baseUrl: "file:///repo/dist/extensions/diffs/index.js",
        stat,
      }),
    ).resolves.toMatchObject({
      pathname: "/repo/dist/extensions/diffs/assets/viewer-runtime.js",
    });
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("falls back to the source asset layout when the built artifact is absent", async () => {
    const stat = vi.fn(async (path: string) => {
      if (path === "/repo/extensions/diffs/assets/viewer-runtime.js") {
        return { mtimeMs: 1 };
      }
      const error = Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      throw error;
    });

    await expect(
      resolveViewerRuntimeFileUrl({
        baseUrl: "file:///repo/extensions/diffs/src/viewer-assets.js",
        stat,
      }),
    ).resolves.toMatchObject({
      pathname: "/repo/extensions/diffs/assets/viewer-runtime.js",
    });
    expect(stat).toHaveBeenNthCalledWith(1, "/repo/extensions/diffs/src/assets/viewer-runtime.js");
    expect(stat).toHaveBeenNthCalledWith(2, "/repo/extensions/diffs/assets/viewer-runtime.js");
  });

  it("serves a stable loader that points at the current runtime bundle", async () => {
    const loader = await getServedViewerAsset(VIEWER_LOADER_PATH);

    expect(loader?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(loader?.body)).toContain(`./viewer-runtime.js?v=`);
  });

  it("serves the runtime bundle body", async () => {
    const runtime = await getServedViewerAsset(VIEWER_RUNTIME_PATH);

    expect(runtime?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(runtime?.body)).toContain("openclawDiffsReady");
    expect(String(runtime?.body)).toContain('style.width="24px"');
    expect(String(runtime?.body)).toContain('style.gap="6px"');
  });

  it("returns null for unknown asset paths", async () => {
    await expect(getServedViewerAsset("/plugins/diffs/assets/not-real.js")).resolves.toBeNull();
  });
});

describe("parseViewerPayloadJson", () => {
  function buildValidPayload(): Record<string, unknown> {
    return {
      langs: ["text"],
      newFile: {
        contents: "after",
        name: "README.md",
      },
      oldFile: {
        contents: "before",
        name: "README.md",
      },
      options: {
        backgroundEnabled: true,
        diffIndicators: "bars",
        diffStyle: "unified",
        disableLineNumbers: false,
        expandUnchanged: false,
        overflow: "wrap",
        theme: {
          dark: "pierre-dark",
          light: "pierre-light",
        },
        themeType: "dark",
        unsafeCSS: ":host{}",
      },
      prerenderedHTML: "<div>ok</div>",
    };
  }

  it("accepts valid payload JSON", () => {
    const parsed = parseViewerPayloadJson(JSON.stringify(buildValidPayload()));
    expect(parsed.options.diffStyle).toBe("unified");
    expect(parsed.options.diffIndicators).toBe("bars");
  });

  it("rejects payloads with invalid shape", () => {
    const broken = buildValidPayload();
    broken.options = {
      ...(broken.options as Record<string, unknown>),
      diffIndicators: "invalid",
    };

    expect(() => parseViewerPayloadJson(JSON.stringify(broken))).toThrow(
      "Diff payload has invalid shape.",
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseViewerPayloadJson("{not-json")).toThrow("Diff payload is not valid JSON.");
  });
});
