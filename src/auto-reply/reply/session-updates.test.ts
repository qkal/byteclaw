import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  resolveAgentConfigMock,
  resolveSessionAgentIdMock,
  resolveAgentIdFromSessionKeyMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn(() => ({ prompt: "", resolvedSkills: [], skills: [] })),
  ensureSkillsWatcherMock: vi.fn(),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    hasAnyBin: () => false,
    hasBin: () => false,
    platforms: [],
  })),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  resolveAgentConfigMock: vi.fn(() => undefined),
  resolveAgentIdFromSessionKeyMock: vi.fn(() => "main"),
  resolveSessionAgentIdMock: vi.fn(() => "writer"),
  shouldRefreshSnapshotForVersionMock: vi.fn(() => false),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
}));

const { ensureSkillSnapshot } = await import("./session-updates.js");

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", resolvedSkills: [], skills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    getRemoteSkillEligibilityMock.mockReturnValue({
      hasAnyBin: () => false,
      hasBin: () => false,
      platforms: [],
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("writer");
    resolveAgentIdFromSessionKeyMock.mockReturnValue("main");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses config-aware session agent resolution for legacy session keys", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    await ensureSkillSnapshot({
      cfg: {
        agents: {
          list: [{ default: true, id: "writer" }],
        },
      },
      isFirstTurnInSession: false,
      sessionKey: "main",
      workspaceDir: "/tmp/workspace",
    });

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      config: {
        agents: {
          list: [{ default: true, id: "writer" }],
        },
      },
      sessionKey: "main",
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      "/tmp/workspace",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(resolveAgentIdFromSessionKeyMock).not.toHaveBeenCalled();
  });
});
