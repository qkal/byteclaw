import { describe, expect, it } from "vitest";
import { isMainModule } from "./is-main.js";

describe("isMainModule", () => {
  it("returns true when argv[1] matches current file", () => {
    expect(
      isMainModule({
        argv: ["node", "/repo/dist/index.js"],
        currentFile: "/repo/dist/index.js",
        cwd: "/repo",
        env: {},
      }),
    ).toBe(true);
  });

  it("returns true under PM2 when pm_exec_path matches current file", () => {
    expect(
      isMainModule({
        argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
        currentFile: "/repo/dist/index.js",
        cwd: "/repo",
        env: { pm_exec_path: "/repo/dist/index.js", pm_id: "0" },
      }),
    ).toBe(true);
  });

  it("resolves relative pm_exec_path values against cwd", () => {
    expect(
      isMainModule({
        argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
        currentFile: "/repo/dist/index.js",
        cwd: "/repo",
        env: { pm_exec_path: "./dist/index.js", pm_id: "0" },
      }),
    ).toBe(true);
  });

  it("returns true for configured wrapper-to-entry pairs", () => {
    expect(
      isMainModule({
        argv: ["node", "/repo/openclaw.mjs"],
        currentFile: "/repo/dist/entry.js",
        cwd: "/repo",
        env: {},
        wrapperEntryPairs: [{ entryBasename: "entry.js", wrapperBasename: "openclaw.mjs" }],
      }),
    ).toBe(true);
  });

  it("returns false for unmatched wrapper launches", () => {
    expect(
      isMainModule({
        argv: ["node", "/repo/openclaw.mjs"],
        currentFile: "/repo/dist/entry.js",
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
    expect(
      isMainModule({
        argv: ["node", "/repo/openclaw.mjs"],
        currentFile: "/repo/dist/index.js",
        cwd: "/repo",
        env: {},
        wrapperEntryPairs: [{ entryBasename: "entry.js", wrapperBasename: "openclaw.mjs" }],
      }),
    ).toBe(false);
  });

  it("returns false when this module is only imported under PM2", () => {
    expect(
      isMainModule({
        argv: ["node", "/repo/app.js"],
        currentFile: "/repo/node_modules/openclaw/dist/index.js",
        cwd: "/repo",
        env: { pm_exec_path: "/repo/app.js", pm_id: "0" },
      }),
    ).toBe(false);
  });

  it("returns false for another entrypoint with the same basename", () => {
    expect(
      isMainModule({
        argv: ["node", "/repo/dist/index.js"],
        currentFile: "/repo/node_modules/openclaw/dist/index.js",
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
  });

  it("returns false when no entrypoint candidate exists", () => {
    expect(
      isMainModule({
        argv: ["node"],
        currentFile: "/repo/dist/index.js",
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
  });
});
