import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

function makeFile(name: string, content: string): WorkspaceBootstrapFile {
  return {
    content,
    missing: false,
    name: name as WorkspaceBootstrapFile["name"],
    path: `/ws/${name}`,
  };
}

describe("getOrLoadBootstrapFiles", () => {
  const files = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];
  let clearAllBootstrapSnapshots: typeof import("./bootstrap-cache.js").clearAllBootstrapSnapshots;
  let getOrLoadBootstrapFiles: typeof import("./bootstrap-cache.js").getOrLoadBootstrapFiles;
  let workspaceModule: typeof import("./workspace.js");

  const mockLoad = () => vi.mocked(workspaceModule.loadWorkspaceBootstrapFiles);

  beforeAll(async () => {
    ({ clearAllBootstrapSnapshots, getOrLoadBootstrapFiles } =
      await import("./bootstrap-cache.js"));
    workspaceModule = await import("./workspace.js");
  });

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad().mockResolvedValue(files);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("loads from disk on first call and caches", async () => {
    const result = await getOrLoadBootstrapFiles({
      sessionKey: "session-1",
      workspaceDir: "/ws",
    });

    expect(result).toBe(files);
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on second call", async () => {
    await getOrLoadBootstrapFiles({ sessionKey: "session-1", workspaceDir: "/ws" });
    const result = await getOrLoadBootstrapFiles({ sessionKey: "session-1", workspaceDir: "/ws" });

    expect(result).toBe(files);
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("different session keys get independent caches", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent v2")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    const r1 = await getOrLoadBootstrapFiles({ sessionKey: "session-1", workspaceDir: "/ws" });
    const r2 = await getOrLoadBootstrapFiles({ sessionKey: "session-2", workspaceDir: "/ws" });

    expect(r1).toBe(files);
    expect(r2).toBe(files2);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });
});

describe("clearBootstrapSnapshot", () => {
  let clearAllBootstrapSnapshots: typeof import("./bootstrap-cache.js").clearAllBootstrapSnapshots;
  let clearBootstrapSnapshot: typeof import("./bootstrap-cache.js").clearBootstrapSnapshot;
  let getOrLoadBootstrapFiles: typeof import("./bootstrap-cache.js").getOrLoadBootstrapFiles;
  let workspaceModule: typeof import("./workspace.js");

  const mockLoad = () => vi.mocked(workspaceModule.loadWorkspaceBootstrapFiles);

  beforeAll(async () => {
    ({ clearAllBootstrapSnapshots, clearBootstrapSnapshot, getOrLoadBootstrapFiles } =
      await import("./bootstrap-cache.js"));
    workspaceModule = await import("./workspace.js");
  });

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad().mockResolvedValue([makeFile("AGENTS.md", "content")]);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("clears a single session entry", async () => {
    await getOrLoadBootstrapFiles({ sessionKey: "sk", workspaceDir: "/ws" });
    clearBootstrapSnapshot("sk");

    // Next call should hit disk again.
    await getOrLoadBootstrapFiles({ sessionKey: "sk", workspaceDir: "/ws" });
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("does not affect other sessions", async () => {
    await getOrLoadBootstrapFiles({ sessionKey: "sk1", workspaceDir: "/ws" });
    await getOrLoadBootstrapFiles({ sessionKey: "sk2", workspaceDir: "/ws" });

    clearBootstrapSnapshot("sk1");

    // Sk2 should still be cached.
    await getOrLoadBootstrapFiles({ sessionKey: "sk2", workspaceDir: "/ws" });
    expect(mockLoad()).toHaveBeenCalledTimes(2); // Sk1 x1, sk2 x1
  });
});
