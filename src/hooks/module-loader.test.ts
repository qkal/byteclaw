import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveFileModuleUrl, resolveFunctionModuleExport } from "./module-loader.js";

describe("hooks module loader helpers", () => {
  it("builds a file URL without cache-busting by default", () => {
    const modulePath = path.resolve("/tmp/hook-handler.js");
    expect(resolveFileModuleUrl({ modulePath })).toBe(pathToFileURL(modulePath).href);
  });

  it("adds a cache-busting query when requested", () => {
    const modulePath = path.resolve("/tmp/hook-handler.js");
    expect(
      resolveFileModuleUrl({
        cacheBust: true,
        modulePath,
        nowMs: 123,
      }),
    ).toBe(`${pathToFileURL(modulePath).href}?t=123`);
  });

  it("resolves explicit function exports", () => {
    const fn = () => "ok";
    const resolved = resolveFunctionModuleExport({
      exportName: "run",
      mod: { run: fn },
    });
    expect(resolved).toBe(fn);
  });

  it("falls back through named exports when no explicit export is provided", () => {
    const fallback = () => "ok";
    const resolved = resolveFunctionModuleExport({
      fallbackExportNames: ["default", "transform"],
      mod: { transform: fallback },
    });
    expect(resolved).toBe(fallback);
  });

  it("returns undefined when export exists but is not callable", () => {
    const resolved = resolveFunctionModuleExport({
      exportName: "run",
      mod: { run: "nope" },
    });
    expect(resolved).toBeUndefined();
  });
});
