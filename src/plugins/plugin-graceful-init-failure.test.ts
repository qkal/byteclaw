import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const fixtureTempDirs: string[] = [];
const fixtureRoot = makeTrackedTempDir("openclaw-plugin-graceful", fixtureTempDirs);
let tempDirIndex = 0;

afterAll(() => {
  cleanupTrackedTempDirs(fixtureTempDirs);
});

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlugin(params: { id: string; body: string; dir?: string }): {
  id: string;
  file: string;
  dir: string;
} {
  const dir = params.dir ?? makeTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${params.id}.cjs`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, params.body, "utf8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      configSchema: { type: "object" },
      id: params.id,
      main: filename,
      name: params.id,
      version: "1.0.0",
    }),
    "utf8",
  );
  return { dir, file, id: params.id };
}

function readPluginId(pluginPath: string): string {
  const manifestPath = path.join(path.dirname(pluginPath), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id: string };
  return manifest.id;
}

async function loadPlugins(pluginPaths: string[], warnings?: string[]) {
  const { loadOpenClawPlugins, clearPluginLoaderCache } = await import("./loader.js");
  clearPluginLoaderCache();
  const allow = pluginPaths.map((pluginPath) => readPluginId(pluginPath));
  return loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        allow,
        enabled: true,
        load: { paths: pluginPaths },
      },
    },
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message: string) => warnings?.push(message),
    },
  });
}

describe("graceful plugin initialization failure", () => {
  it("does not crash when register throws", async () => {
    const plugin = writePlugin({
      body: `module.exports = { id: "throws-on-register", register() { throw new Error("config schema mismatch"); } };`,
      id: "throws-on-register",
    });

    await expect(loadPlugins([plugin.file])).resolves.toBeDefined();
  });

  it("keeps loading other plugins after one register failure", async () => {
    const failing = writePlugin({
      body: `module.exports = { id: "plugin-fail", register() { throw new Error("boom"); } };`,
      id: "plugin-fail",
    });
    const working = writePlugin({
      body: `module.exports = { id: "plugin-ok", register() {} };`,
      id: "plugin-ok",
    });

    const registry = await loadPlugins([failing.file, working.file]);

    expect(registry.plugins.find((plugin) => plugin.id === "plugin-ok")?.status).toBe("loaded");
  });

  it("records failed register metadata", async () => {
    const plugin = writePlugin({
      body: `module.exports = { id: "register-error", register() { throw new Error("brutal config fail"); } };`,
      id: "register-error",
    });

    const before = new Date();
    const registry = await loadPlugins([plugin.file]);
    const after = new Date();

    const failed = registry.plugins.find((entry) => entry.id === "register-error");
    expect(failed).toBeDefined();
    expect(failed?.status).toBe("error");
    expect(failed?.failurePhase).toBe("register");
    expect(failed?.error).toContain("brutal config fail");
    expect(failed?.failedAt).toBeInstanceOf(Date);
    expect(failed?.failedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(failed?.failedAt?.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("records validation failures before register", async () => {
    const plugin = writePlugin({
      body: `module.exports = { id: "missing-register" };`,
      id: "missing-register",
    });

    const registry = await loadPlugins([plugin.file]);
    const failed = registry.plugins.find((entry) => entry.id === "missing-register");

    expect(failed?.status).toBe("error");
    expect(failed?.failurePhase).toBe("validation");
    expect(failed?.error).toBe("plugin export missing register/activate");
  });

  it("logs a startup summary grouped by failure phase", async () => {
    const registerFailure = writePlugin({
      body: `module.exports = { id: "warn-register", register() { throw new Error("bad config"); } };`,
      id: "warn-register",
    });
    const validationFailure = writePlugin({
      body: `module.exports = { id: "warn-validation" };`,
      id: "warn-validation",
    });

    const warnings: string[] = [];
    await loadPlugins([registerFailure.file, validationFailure.file], warnings);

    const summary = warnings.find((warning) => warning.includes("failed to initialize"));
    expect(summary).toBeDefined();
    expect(summary).toContain("register: warn-register");
    expect(summary).toContain("validation: warn-validation");
    expect(summary).toContain("openclaw plugins list");
  });
});
