import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn(() => ({}));
const resolveDefaultAgentIdMock = vi.fn(() => "main");
const resolveAgentWorkspaceDirMock = vi.fn(() => "/tmp/workspace");
const installSkillFromClawHubMock = vi.fn();
const installSkillMock = vi.fn();
const updateSkillsFromClawHubMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveAgentWorkspaceDir: () => resolveAgentWorkspaceDirMock(),
  resolveDefaultAgentId: () => resolveDefaultAgentIdMock(),
}));

vi.mock("../../agents/skills-clawhub.js", () => ({
  installSkillFromClawHub: (...args: unknown[]) => installSkillFromClawHubMock(...args),
  updateSkillsFromClawHub: (...args: unknown[]) => updateSkillsFromClawHubMock(...args),
}));

vi.mock("../../agents/skills-install.js", () => ({
  installSkill: (...args: unknown[]) => installSkillMock(...args),
}));

const { skillsHandlers } = await import("./skills.js");

describe("skills gateway handlers (clawhub)", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    installSkillFromClawHubMock.mockReset();
    installSkillMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();

    loadConfigMock.mockReturnValue({});
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
  });

  it("installs a ClawHub skill through skills.install", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      targetDir: "/tmp/workspace/skills/calendar",
      version: "1.2.3",
    });

    let ok: boolean | null = null;
    let response: unknown;
    let error: unknown;
    await skillsHandlers["skills.install"]({
      client: null as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {
        slug: "calendar",
        source: "clawhub",
        version: "1.2.3",
      },
      req: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result;
        error = err;
      },
    });

    expect(installSkillFromClawHubMock).toHaveBeenCalledWith({
      force: false,
      slug: "calendar",
      version: "1.2.3",
      workspaceDir: "/tmp/workspace",
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toMatchObject({
      message: "Installed calendar@1.2.3",
      ok: true,
      slug: "calendar",
      version: "1.2.3",
    });
  });

  it("forwards dangerous override for local skill installs", async () => {
    installSkillMock.mockResolvedValue({
      code: 0,
      message: "Installed",
      ok: true,
      stderr: "",
      stdout: "",
    });

    let ok: boolean | null = null;
    let response: unknown;
    let error: unknown;
    await skillsHandlers["skills.install"]({
      client: null as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {
        dangerouslyForceUnsafeInstall: true,
        installId: "deps",
        name: "calendar",
        timeoutMs: 120_000,
      },
      req: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result;
        error = err;
      },
    });

    expect(installSkillMock).toHaveBeenCalledWith({
      config: {},
      dangerouslyForceUnsafeInstall: true,
      installId: "deps",
      skillName: "calendar",
      timeoutMs: 120_000,
      workspaceDir: "/tmp/workspace",
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toMatchObject({
      message: "Installed",
      ok: true,
    });
  });

  it("updates ClawHub skills through skills.update", async () => {
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        changed: true,
        ok: true,
        previousVersion: "1.2.2",
        slug: "calendar",
        targetDir: "/tmp/workspace/skills/calendar",
        version: "1.2.3",
      },
    ]);

    let ok: boolean | null = null;
    let response: unknown;
    let error: unknown;
    await skillsHandlers["skills.update"]({
      client: null as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {
        slug: "calendar",
        source: "clawhub",
      },
      req: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result;
        error = err;
      },
    });

    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      slug: "calendar",
      workspaceDir: "/tmp/workspace",
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toMatchObject({
      config: {
        results: [
          {
            ok: true,
            slug: "calendar",
            version: "1.2.3",
          },
        ],
        source: "clawhub",
      },
      ok: true,
      skillKey: "calendar",
    });
  });

  it("rejects ClawHub skills.update requests without slug or all", async () => {
    let ok: boolean | null = null;
    let error: { code?: string; message?: string } | undefined;
    await skillsHandlers["skills.update"]({
      client: null as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {
        source: "clawhub",
      },
      req: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err as { code?: string; message?: string } | undefined;
      },
    });

    expect(ok).toBe(false);
    expect(error?.message).toContain('requires "slug" or "all"');
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
  });
});
