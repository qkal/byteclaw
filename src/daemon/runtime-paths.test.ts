import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: fsMocks.access,
    default: {
      ...actual,
      access: fsMocks.access,
    },
  };
});

import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveStableNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
  vi.resetAllMocks();
});

function mockNodePathPresent(...nodePaths: string[]) {
  fsMocks.access.mockImplementation(async (target: string) => {
    if (nodePaths.includes(target)) {
      return;
    }
    throw new Error("missing");
  });
}

describe("resolvePreferredNodePath", () => {
  const darwinNode = "/opt/homebrew/bin/node";
  const fnmNode = "/Users/test/.fnm/node-versions/v24.11.1/installation/bin/node";

  it("prefers execPath (version manager node) over system node", async () => {
    mockNodePathPresent(darwinNode);

    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "24.11.1\n" });

    const result = await resolvePreferredNodePath({
      env: {},
      execFile,
      execPath: fnmNode,
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe(fnmNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to system node when execPath version is unsupported", async () => {
    mockNodePathPresent(darwinNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stderr: "", stdout: "18.0.0\n" }) // ExecPath too old
      .mockResolvedValueOnce({ stderr: "", stdout: "22.14.0\n" }); // System node ok

    const result = await resolvePreferredNodePath({
      env: {},
      execFile,
      execPath: "/some/old/node",
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("ignores execPath when it is not node", async () => {
    mockNodePathPresent(darwinNode);

    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "22.14.0\n" });

    const result = await resolvePreferredNodePath({
      env: {},
      execFile,
      execPath: "/Users/test/.bun/bin/bun",
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(darwinNode, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
  });

  it("uses system node when it meets the minimum version", async () => {
    mockNodePathPresent(darwinNode);

    // Node 22.14.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "22.14.0\n" });

    const result = await resolvePreferredNodePath({
      env: {},
      execFile,
      execPath: darwinNode,
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("skips system node when it is too old", async () => {
    mockNodePathPresent(darwinNode);

    // Node 22.13.x is below minimum 22.14.0
    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "22.13.0\n" });

    const result = await resolvePreferredNodePath({
      env: {},
      execFile,
      execPath: "",
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when no system node is found", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const execFile = vi.fn().mockRejectedValue(new Error("not found"));

    const result = await resolvePreferredNodePath({
      env: {},
      execFile,
      execPath: "",
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveStableNodePath", () => {
  it("resolves Homebrew Cellar path to opt symlink", async () => {
    mockNodePathPresent("/opt/homebrew/opt/node/bin/node");

    const result = await resolveStableNodePath("/opt/homebrew/Cellar/node/25.7.0/bin/node");
    expect(result).toBe("/opt/homebrew/opt/node/bin/node");
  });

  it("falls back to bin symlink for default node formula", async () => {
    mockNodePathPresent("/opt/homebrew/bin/node");

    const result = await resolveStableNodePath("/opt/homebrew/Cellar/node/25.7.0/bin/node");
    expect(result).toBe("/opt/homebrew/bin/node");
  });

  it("resolves Intel Mac Cellar path to opt symlink", async () => {
    mockNodePathPresent("/usr/local/opt/node/bin/node");

    const result = await resolveStableNodePath("/usr/local/Cellar/node/25.7.0/bin/node");
    expect(result).toBe("/usr/local/opt/node/bin/node");
  });

  it("resolves versioned node@22 formula to opt symlink", async () => {
    mockNodePathPresent("/opt/homebrew/opt/node@22/bin/node");

    const result = await resolveStableNodePath("/opt/homebrew/Cellar/node@22/22.14.0/bin/node");
    expect(result).toBe("/opt/homebrew/opt/node@22/bin/node");
  });

  it("returns original path when no stable symlink exists", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const cellarPath = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const result = await resolveStableNodePath(cellarPath);
    expect(result).toBe(cellarPath);
  });

  it("returns non-Cellar paths unchanged", async () => {
    const fnmPath = "/Users/test/.fnm/node-versions/v24.11.1/installation/bin/node";
    const result = await resolveStableNodePath(fnmPath);
    expect(result).toBe(fnmPath);
  });

  it("returns system paths unchanged", async () => {
    const result = await resolveStableNodePath("/opt/homebrew/bin/node");
    expect(result).toBe("/opt/homebrew/bin/node");
  });
});

describe("resolvePreferredNodePath — Homebrew Cellar", () => {
  it("resolves Cellar execPath to stable Homebrew symlink", async () => {
    const cellarNode = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const stableNode = "/opt/homebrew/opt/node/bin/node";
    mockNodePathPresent(stableNode);

    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "25.7.0\n" });

    const result = await resolvePreferredNodePath({
      env: {},
      execFile,
      execPath: cellarNode,
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe(stableNode);
  });
});

describe("resolveSystemNodeInfo", () => {
  const darwinNode = "/opt/homebrew/bin/node";

  it("returns supported info when version is new enough", async () => {
    mockNodePathPresent(darwinNode);

    // Node 22.14.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "22.14.0\n" });

    const result = await resolveSystemNodeInfo({
      env: {},
      execFile,
      platform: "darwin",
    });

    expect(result).toEqual({
      path: darwinNode,
      supported: true,
      version: "22.14.0",
    });
  });

  it("returns undefined when system node is missing", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));
    const execFile = vi.fn();
    const result = await resolveSystemNodeInfo({ env: {}, execFile, platform: "darwin" });
    expect(result).toBeNull();
  });

  it("renders a warning when system node is too old", () => {
    const warning = renderSystemNodeWarning(
      {
        path: darwinNode,
        supported: false,
        version: "18.19.0",
      },
      "/Users/me/.fnm/node-22/bin/node",
    );

    expect(warning).toContain("below the required Node 22.14+");
    expect(warning).toContain(darwinNode);
  });

  it("uses validated custom Program Files roots on Windows", async () => {
    const customNode = String.raw`D:\Programs\nodejs\node.exe`;
    mockNodePathPresent(customNode);

    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "24.11.1\n" });
    const result = await resolveSystemNodeInfo({
      env: {
        ProgramFiles: "D:\\Programs",
        "ProgramFiles(x86)": String.raw`E:\Programs (x86)`,
      },
      execFile,
      platform: "win32",
    });

    expect(result?.path).toBe(customNode);
  });

  it("prefers ProgramW6432 over ProgramFiles on Windows", async () => {
    const preferredNode = String.raw`D:\Programs\nodejs\node.exe`;
    const x86Node = String.raw`E:\Programs (x86)\nodejs\node.exe`;
    mockNodePathPresent(preferredNode, x86Node);

    const execFile = vi.fn().mockResolvedValue({ stderr: "", stdout: "24.11.1\n" });
    const result = await resolveSystemNodeInfo({
      env: {
        ProgramFiles: "E:\\Programs (x86)",
        "ProgramFiles(x86)": String.raw`E:\Programs (x86)`,
        ProgramW6432: "D:\\Programs",
      },
      execFile,
      platform: "win32",
    });

    expect(result?.path).toBe(preferredNode);
  });
});
