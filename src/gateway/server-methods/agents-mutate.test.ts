import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  applyAgentConfig: vi.fn((_cfg: unknown, _opts: unknown) => ({})),
  ensureAgentWorkspace: vi.fn(
    async (params?: { dir?: string }): Promise<{ dir: string; identityPathCreated: boolean }> => ({
      dir: params?.dir
        ? `/resolved${params.dir.startsWith("/") ? "" : "/"}${params.dir}`
        : "/resolved/workspace",
      identityPathCreated: false,
    }),
  ),
  findAgentEntryIndex: vi.fn((_list?: unknown, _agentId?: string) => -1),
  fsAccess: vi.fn(async () => {}),
  fsAppendFile: vi.fn(async () => {}),
  fsLstat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsMkdir: vi.fn(async () => undefined),
  fsOpen: vi.fn(async () => ({}) as unknown),
  fsReadFile: vi.fn(async () => ""),
  fsReadlink: vi.fn(async () => ""),
  fsRealpath: vi.fn(async (p: string) => p),
  fsStat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  isWorkspaceSetupCompleted: vi.fn(async () => false),
  listAgentEntries: vi.fn((_cfg?: unknown) => [] as Record<string, unknown>[]),
  listAgentsForGateway: vi.fn(() => ({
    agents: [],
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
  })),
  loadConfigReturn: {} as Record<string, unknown>,
  movePathToTrash: vi.fn(async () => "/trashed"),
  pruneAgentConfig: vi.fn(() => ({ config: {}, removedBindings: 0 })),
  resolveAgentDir: vi.fn((_cfg?: unknown, _agentId?: string) => "/agents/test-agent"),
  resolveAgentWorkspaceDir: vi.fn((_cfg?: unknown, _agentId?: string) => "/workspace/test-agent"),
  resolveSessionTranscriptsDirForAgent: vi.fn((_agentId?: string) => "/transcripts/test-agent"),
  writeConfigFile: vi.fn(async () => {}),
  writeFileWithinRoot: vi.fn(async () => {}),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => mocks.loadConfigReturn,
    writeConfigFile: mocks.writeConfigFile,
  };
});

vi.mock("../../commands/agents.config.js", () => ({
  applyAgentConfig: mocks.applyAgentConfig,
  findAgentEntryIndex: mocks.findAgentEntryIndex,
  listAgentEntries: mocks.listAgentEntries,
  pruneAgentConfig: mocks.pruneAgentConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentConfig: (cfg: unknown, agentId: string) =>
    getAgentList(cfg).find((entry) => entry.id === agentId),
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/workspace.js")>(
    "../../agents/workspace.js",
  );
  return {
    ...actual,
    ensureAgentWorkspace: mocks.ensureAgentWorkspace,
    isWorkspaceSetupCompleted: mocks.isWorkspaceSetupCompleted,
  };
});

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: mocks.resolveSessionTranscriptsDirForAgent,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    resolveUserPath: (p: string) => `/resolved${p.startsWith("/") ? "" : "/"}${p}`,
  };
});

vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
}));

vi.mock("../../infra/fs-safe.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/fs-safe.js")>("../../infra/fs-safe.js");
  return {
    ...actual,
    writeFileWithinRoot: mocks.writeFileWithinRoot,
  };
});

// Mock node:fs/promises – agents.ts uses `import fs from "node:fs/promises"`
// Which resolves to the module namespace default, so we spread actual and
// Override the methods we need, plus set `default` explicitly.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const patched = {
    ...actual,
    access: mocks.fsAccess,
    appendFile: mocks.fsAppendFile,
    lstat: mocks.fsLstat,
    mkdir: mocks.fsMkdir,
    open: mocks.fsOpen,
    readFile: mocks.fsReadFile,
    readlink: mocks.fsReadlink,
    realpath: mocks.fsRealpath,
    stat: mocks.fsStat,
  };
  return { ...patched, default: patched };
});

/* ------------------------------------------------------------------ */
/* Import after mocks are set up                                      */
/* ------------------------------------------------------------------ */

const { __testing: agentsTesting, agentsHandlers } = await import("./agents.js");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  agentsTesting.resetDepsForTests();
  mocks.listAgentEntries.mockImplementation((cfg: unknown) => getAgentList(cfg));
  mocks.findAgentEntryIndex.mockImplementation((list: unknown, agentId?: string) =>
    (Array.isArray(list) ? (list as MockAgentEntry[]) : []).findIndex(
      (entry) => entry.id === agentId,
    ),
  );
  mocks.applyAgentConfig.mockImplementation((cfg: unknown, opts: unknown) =>
    mergeAgentConfig(cfg, opts),
  );
  mocks.resolveAgentWorkspaceDir.mockImplementation((cfg: unknown, agentId?: string) =>
    resolveMockWorkspaceDir(cfg, agentId),
  );
  mocks.writeFileWithinRoot.mockResolvedValue(undefined);
});

function makeCall(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = agentsHandlers[method];
  const promise = handler({
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params,
    req: { id: "1", method, type: "req" as const },
    respond,
  });
  return { promise, respond };
}

function createEnoentError() {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function createErrnoError(code: string) {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeFileStat(params?: {
  size?: number;
  mtimeMs?: number;
  dev?: number;
  ino?: number;
  nlink?: number;
}): import("node:fs").Stats {
  return {
    dev: params?.dev ?? 1,
    ino: params?.ino ?? 1,
    isFile: () => true,
    isSymbolicLink: () => false,
    mtimeMs: params?.mtimeMs ?? 1234,
    nlink: params?.nlink ?? 1,
    size: params?.size ?? 10,
  } as unknown as import("node:fs").Stats;
}

interface MockIdentity {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
}

interface MockAgentEntry {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
  identity?: MockIdentity;
}

interface MockConfig {
  agents?: {
    list?: MockAgentEntry[];
  };
}

function getAgentList(cfg: unknown): MockAgentEntry[] {
  return ((cfg as MockConfig | undefined)?.agents?.list ?? []).map((entry) => ({ ...entry }));
}

function mergeAgentConfig(cfg: unknown, opts: unknown): MockConfig {
  const config = (cfg as MockConfig | undefined) ?? {};
  const params = (opts as {
    agentId?: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string;
    identity?: MockIdentity;
  }) ?? { agentId: "" };
  const list = getAgentList(config);
  const agentId = String(params.agentId ?? "");
  const index = list.findIndex((entry) => entry.id === agentId);
  const base = index !== -1 ? list[index] : { id: agentId };
  const nextEntry: MockAgentEntry = {
    ...base,
    ...(params.name ? { name: params.name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.identity ? { identity: { ...base.identity, ...params.identity } } : {}),
  };
  if (index !== -1) {
    list[index] = nextEntry;
  } else {
    list.push(nextEntry);
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      list,
    },
  };
}

function resolveMockWorkspaceDir(cfg: unknown, agentId?: string): string {
  const resolvedAgentId = agentId ?? "";
  return (
    getAgentList(cfg).find((entry) => entry.id === resolvedAgentId)?.workspace ??
    `/workspace/${resolvedAgentId}`
  );
}

function mockWorkspaceStateRead(params: {
  setupCompletedAt?: string;
  errorCode?: string;
  rawContent?: string;
}) {
  agentsTesting.setDepsForTests({
    isWorkspaceSetupCompleted: async () => {
      if (params.errorCode) {
        throw createErrnoError(params.errorCode);
      }
      if (typeof params.rawContent === "string") {
        throw new SyntaxError("Expected property name or '}' in JSON");
      }
      return (
        typeof params.setupCompletedAt === "string" && params.setupCompletedAt.trim().length > 0
      );
    },
  });
  mocks.isWorkspaceSetupCompleted.mockImplementation(async () => {
    if (params.errorCode) {
      throw createErrnoError(params.errorCode);
    }
    if (typeof params.rawContent === "string") {
      throw new SyntaxError("Expected property name or '}' in JSON");
    }
    return typeof params.setupCompletedAt === "string" && params.setupCompletedAt.trim().length > 0;
  });
}

async function listAgentFileNames(agentId = "main") {
  const { respond, promise } = makeCall("agents.files.list", { agentId });
  await promise;

  const [, result] = respond.mock.calls[0] ?? [];
  const { files } = result as { files: { name: string }[] };
  return files.map((file) => file.name);
}

function expectNotFoundResponseAndNoWrite(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("not found") }),
  );
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
}

async function expectUnsafeWorkspaceFile(method: "agents.files.get" | "agents.files.set") {
  const params =
    method === "agents.files.set"
      ? { agentId: "main", content: "x", name: "AGENTS.md" }
      : { agentId: "main", name: "AGENTS.md" };
  const { respond, promise } = makeCall(method, params);
  await promise;
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
  );
}

beforeEach(() => {
  mocks.fsReadFile.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsStat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsLstat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsRealpath.mockImplementation(async (p: string) => p);
  mocks.fsOpen.mockImplementation(
    async () =>
      ({
        close: async () => {},
        readFile: async () => Buffer.from(""),
        stat: async () => makeFileStat(),
        truncate: async () => {},
        writeFile: async () => {},
      }) as unknown,
  );
});

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("agents.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(-1);
  });

  it("creates a new agent successfully", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "Test Agent",
      workspace: "/home/user/agents/test",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "test-agent",
        name: "Test Agent",
        ok: true,
      }),
      undefined,
    );
    expect(mocks.ensureAgentWorkspace).toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalled();
  });

  it("ensures workspace is set up before writing config", async () => {
    const callOrder: string[] = [];
    mocks.ensureAgentWorkspace.mockImplementation(async () => {
      callOrder.push("ensureAgentWorkspace");
      return { dir: "/resolved/tmp/ws", identityPathCreated: false };
    });
    mocks.writeConfigFile.mockImplementation(async () => {
      callOrder.push("writeConfigFile");
    });

    const { promise } = makeCall("agents.create", {
      name: "Order Test",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(callOrder.indexOf("ensureAgentWorkspace")).toBeLessThan(
      callOrder.indexOf("writeConfigFile"),
    );
  });

  it("rejects creating an agent with reserved 'main' id", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "main",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("reserved") }),
    );
  });

  it("rejects creating a duplicate agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(0);

    const { respond, promise } = makeCall("agents.create", {
      name: "Existing",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("already exists") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects invalid params (missing name)", async () => {
    const { respond, promise } = makeCall("agents.create", {
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid") }),
    );
  });

  it("writes identity to both config and IDENTITY.md", async () => {
    const { promise } = makeCall("agents.create", {
      name: "Plain Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({ name: "Plain Agent" }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("- Name: Plain Agent"),
        relativePath: "IDENTITY.md",
        rootDir: "/resolved/tmp/ws",
      }),
    );
  });

  it("writes emoji and avatar to both config and IDENTITY.md", async () => {
    const { promise } = makeCall("agents.create", {
      avatar: "https://example.com/avatar.png",
      emoji: "🤖",
      name: "Fancy Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({
          avatar: "https://example.com/avatar.png",
          emoji: "🤖",
          name: "Fancy Agent",
        }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringMatching(/- Name: Fancy Agent[\s\S]*- Emoji: 🤖[\s\S]*- Avatar:/),
        relativePath: "IDENTITY.md",
        rootDir: "/resolved/tmp/ws",
      }),
    );
  });

  it("does not persist config when IDENTITY.md write fails with SafeOpenError", async () => {
    const { SafeOpenError: SOE } = await import("../../infra/fs-safe.js");
    mocks.writeFileWithinRoot.mockRejectedValueOnce(
      new SOE("path-mismatch", "path escapes workspace root"),
    );

    const { respond, promise } = makeCall("agents.create", {
      name: "Unsafe Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not persist config when IDENTITY.md read fails", async () => {
    agentsTesting.setDepsForTests({
      readLocalFileSafely: async () => {
        throw createErrnoError("EACCES");
      },
      resolveAgentWorkspaceFilePath: async ({ workspaceDir, name }) => {
        const ioPath = `${workspaceDir}/${name}`;
        if (workspaceDir === "/resolved/tmp/ws") {
          return {
            ioPath,
            kind: "ready",
            requestPath: ioPath,
            workspaceReal: workspaceDir,
          };
        }
        return {
          ioPath,
          kind: "missing",
          requestPath: ioPath,
          workspaceReal: workspaceDir,
        };
      },
    });
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/tmp/ws",
      identityPathCreated: false,
    });

    const { promise } = makeCall("agents.create", {
      name: "Unreadable Identity",
      workspace: "/tmp/ws",
    });

    await expect(promise).rejects.toMatchObject({ code: "EACCES" });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalled();
  });

  it("passes model to applyAgentConfig when provided", async () => {
    const { respond, promise } = makeCall("agents.create", {
      model: "sonnet-4.6",
      name: "Model Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ model: "sonnet-4.6", ok: true }),
      undefined,
    );
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "sonnet-4.6" }),
    );
  });
});

describe("agents.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {
      agents: {
        list: [
          {
            id: "test-agent",
            identity: {
              emoji: "🐢",
              name: "Current Agent",
              theme: "steady",
            },
            workspace: "/workspace/test-agent",
          },
        ],
      },
    };
  });

  it("updates an existing agent successfully", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Updated Name",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { agentId: "test-agent", ok: true }, undefined);
    expect(mocks.writeConfigFile).toHaveBeenCalled();
  });

  it("rejects updating a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const { respond, promise } = makeCall("agents.update", {
      agentId: "nonexistent",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("ensures workspace when workspace changes", async () => {
    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expect(mocks.ensureAgentWorkspace).toHaveBeenCalled();
  });

  it("does not ensure workspace when workspace is unchanged", async () => {
    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Just a rename",
    });
    await promise;

    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("writes merged identity to IDENTITY.md when only avatar changes", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { agentId: "test-agent", ok: true }, undefined);
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({
          avatar: "https://example.com/avatar.png",
        }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringMatching(
          /- Name: Current Agent[\s\S]*- Theme: steady[\s\S]*- Emoji: 🐢[\s\S]*- Avatar: https:\/\/example\.com\/avatar\.png/,
        ),
        relativePath: "IDENTITY.md",
        rootDir: "/workspace/test-agent",
      }),
    );
  });

  it("writes merged identity to IDENTITY.md when only emoji changes", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      emoji: "🦀",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { agentId: "test-agent", ok: true }, undefined);
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({ emoji: "🦀" }),
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringMatching(
          /- Name: Current Agent[\s\S]*- Theme: steady[\s\S]*- Emoji: 🦀/,
        ),
        relativePath: "IDENTITY.md",
        rootDir: "/workspace/test-agent",
      }),
    );
  });

  it("writes combined identity fields to both config and IDENTITY.md", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/new.png",
      emoji: "🤖",
      name: "New Name",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { agentId: "test-agent", ok: true }, undefined);
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({
          avatar: "https://example.com/new.png",
          emoji: "🤖",
          name: "New Name",
        }),
        name: "New Name",
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringMatching(
          /- Name: New Name[\s\S]*- Theme: steady[\s\S]*- Emoji: 🤖[\s\S]*- Avatar: https:\/\/example\.com\/new\.png/,
        ),
        relativePath: "IDENTITY.md",
        rootDir: "/workspace/test-agent",
      }),
    );
  });

  it("syncs existing identity into a new workspace even without identity params", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/new/workspace",
      identityPathCreated: true,
    });
    agentsTesting.setDepsForTests({
      readLocalFileSafely: async ({ filePath }) => {
        if (filePath === "/workspace/test-agent/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** Current Agent",
                "- **Creature:** Steady Turtle",
                "- **Vibe:** Calm and methodical",
                "- **Emoji:** 🐢",
                "",
                "## Role",
                "",
                "Protect the queue.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        if (filePath === "/resolved/new/workspace/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** C-3PO (Clawd's Third Protocol Observer)",
                "- **Creature:** Flustered Protocol Droid",
                "",
                "## Role",
                "",
                "Debug agent for `--dev` mode.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        throw createEnoentError();
      },
      resolveAgentWorkspaceFilePath: async ({ workspaceDir, name }) => {
        const ioPath = `${workspaceDir}/${name}`;
        if (
          workspaceDir === "/workspace/test-agent" ||
          workspaceDir === "/resolved/new/workspace"
        ) {
          return {
            ioPath,
            kind: "ready",
            requestPath: ioPath,
            workspaceReal: workspaceDir,
          };
        }
        return {
          ioPath,
          kind: "missing",
          requestPath: ioPath,
          workspaceReal: workspaceDir,
        };
      },
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { agentId: "test-agent", ok: true }, undefined);
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("- **Creature:** Steady Turtle"),
        relativePath: "IDENTITY.md",
        rootDir: "/resolved/new/workspace",
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("## Role"),
      }),
    );
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("Flustered Protocol Droid"),
      }),
    );
  });

  it("preserves an existing destination identity file when workspace changes", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValueOnce({
      dir: "/resolved/new/workspace",
      identityPathCreated: false,
    });
    agentsTesting.setDepsForTests({
      readLocalFileSafely: async ({ filePath }) => {
        if (filePath === "/workspace/test-agent/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** Current Agent",
                "- **Creature:** Old Turtle",
                "",
                "## Role",
                "",
                "Old workspace role.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        if (filePath === "/resolved/new/workspace/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** Destination Agent",
                "- **Creature:** Destination Fox",
                "",
                "## Role",
                "",
                "Destination workspace role.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        throw createEnoentError();
      },
      resolveAgentWorkspaceFilePath: async ({ workspaceDir, name }) => {
        const ioPath = `${workspaceDir}/${name}`;
        if (
          workspaceDir === "/workspace/test-agent" ||
          workspaceDir === "/resolved/new/workspace"
        ) {
          return {
            ioPath,
            kind: "ready",
            requestPath: ioPath,
            workspaceReal: workspaceDir,
          };
        }
        return {
          ioPath,
          kind: "missing",
          requestPath: ioPath,
          workspaceReal: workspaceDir,
        };
      },
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { agentId: "test-agent", ok: true }, undefined);
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("- **Creature:** Destination Fox"),
        relativePath: "IDENTITY.md",
        rootDir: "/resolved/new/workspace",
      }),
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("Destination workspace role."),
      }),
    );
    expect(mocks.writeFileWithinRoot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("Old workspace role."),
      }),
    );
  });

  it("does not persist config when IDENTITY.md write fails on update", async () => {
    const { SafeOpenError: SOE } = await import("../../infra/fs-safe.js");
    mocks.writeFileWithinRoot.mockRejectedValueOnce(
      new SOE("path-mismatch", "path escapes workspace root"),
    );

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/avatar.png",
      name: "Bad Update",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });
});

describe("agents.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(0);
    mocks.pruneAgentConfig.mockReturnValue({ config: {}, removedBindings: 2 });
  });

  it("deletes an existing agent and trashes files by default", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      { agentId: "test-agent", ok: true, removedBindings: 2 },
      undefined,
    );
    expect(mocks.writeConfigFile).toHaveBeenCalled();
    // MoveToTrashBestEffort calls fs.access then movePathToTrash for each dir
    expect(mocks.movePathToTrash).toHaveBeenCalled();
  });

  it("skips file deletion when deleteFiles is false", async () => {
    mocks.fsAccess.mockClear();

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    // MoveToTrashBestEffort should not be called at all
    expect(mocks.fsAccess).not.toHaveBeenCalled();
  });

  it("rejects deleting the main agent", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "main",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("cannot be deleted") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects deleting a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "ghost",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("rejects invalid params (missing agentId)", async () => {
    const { respond, promise } = makeCall("agents.delete", {});
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid") }),
    );
  });
});

describe("agents.files.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.isWorkspaceSetupCompleted.mockReset().mockResolvedValue(false);
    mocks.fsReadlink.mockReset().mockResolvedValue("");
  });

  it("includes BOOTSTRAP.md when setup has not completed", async () => {
    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("hides BOOTSTRAP.md when workspace setup is complete", async () => {
    mockWorkspaceStateRead({ setupCompletedAt: "2026-02-15T14:00:00.000Z" });

    const names = await listAgentFileNames();
    expect(names).not.toContain("BOOTSTRAP.md");
  });

  it("falls back to showing BOOTSTRAP.md when workspace state cannot be read", async () => {
    mockWorkspaceStateRead({ errorCode: "EACCES" });

    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("falls back to showing BOOTSTRAP.md when workspace state is malformed JSON", async () => {
    mockWorkspaceStateRead({ rawContent: "{" });

    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });
});

describe("agents.files.get/set symlink safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {
      agents: {
        list: [{ id: "main", workspace: "/workspace/test-agent" }],
      },
    };
    mocks.fsMkdir.mockResolvedValue(undefined);
  });

  function mockWorkspaceEscapeSymlink() {
    const workspace = "/workspace/test-agent";
    agentsTesting.setDepsForTests({
      resolveAgentWorkspaceFilePath: async ({ name }) => ({
        kind: "invalid",
        reason: "path escapes workspace root",
        requestPath: path.join(workspace, name),
      }),
    });
  }

  it.each([
    { expectNoOpen: false, method: "agents.files.get" as const },
    { expectNoOpen: true, method: "agents.files.set" as const },
  ])(
    "rejects $method when allowlisted file symlink escapes workspace",
    async ({ method, expectNoOpen }) => {
      mockWorkspaceEscapeSymlink();
      await expectUnsafeWorkspaceFile(method);
      if (expectNoOpen) {
        expect(mocks.fsOpen).not.toHaveBeenCalled();
      }
    },
  );

  it("allows in-workspace symlink reads and writes through symlink aliases", async () => {
    const workspace = "/workspace/test-agent";
    const target = path.resolve(workspace, "policies", "AGENTS.md");
    const targetStat = makeFileStat({ dev: 9, ino: 42, mtimeMs: 1700, size: 7 });

    agentsTesting.setDepsForTests({
      readLocalFileSafely: async () => ({
        buffer: Buffer.from("inside\n"),
        realPath: target,
        stat: targetStat,
      }),
      resolveAgentWorkspaceFilePath: async ({ name }) => ({
        ioPath: target,
        kind: "ready",
        requestPath: path.join(workspace, name),
        workspaceReal: workspace,
      }),
    });
    mocks.fsLstat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === target) {
        return targetStat;
      }
      throw createEnoentError();
    });
    mocks.fsStat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === target) {
        return targetStat;
      }
      throw createEnoentError();
    });

    const getCall = makeCall("agents.files.get", { agentId: "main", name: "AGENTS.md" });
    await getCall.promise;
    expect(getCall.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file: expect.objectContaining({ content: "inside\n", missing: false }),
      }),
      undefined,
    );

    const setCall = makeCall("agents.files.set", {
      agentId: "main",
      content: "updated\n",
      name: "AGENTS.md",
    });
    await setCall.promise;
    expect(setCall.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file: expect.objectContaining({
          content: "updated\n",
          missing: false,
        }),
      }),
      undefined,
    );
  });

  function mockHardlinkedWorkspaceAlias() {
    const workspace = "/workspace/test-agent";
    const candidate = path.resolve(workspace, "AGENTS.md");
    mocks.fsRealpath.mockImplementation(async (p: string) => {
      if (p === workspace) {
        return workspace;
      }
      return p;
    });
    mocks.fsLstat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === candidate) {
        return makeFileStat({ nlink: 2 });
      }
      throw createEnoentError();
    });
  }

  it.each([
    { expectNoOpen: false, method: "agents.files.get" as const },
    { expectNoOpen: true, method: "agents.files.set" as const },
  ])(
    "rejects $method when allowlisted file is a hardlinked alias",
    async ({ method, expectNoOpen }) => {
      mockHardlinkedWorkspaceAlias();
      await expectUnsafeWorkspaceFile(method);
      if (expectNoOpen) {
        expect(mocks.fsOpen).not.toHaveBeenCalled();
      }
    },
  );
});
