import { vi } from "vitest";

vi.mock("../logging/subsystem.js", () => {
  const createMockLogger = () => ({
    child: vi.fn(() => createMockLogger()),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    isEnabled: vi.fn(() => true),
    raw: vi.fn(),
    subsystem: "test",
    trace: vi.fn(),
    warn: vi.fn(),
  });
  return {
    createSubsystemLogger: vi.fn(() => createMockLogger()),
  };
});

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENTS_FILENAME: "AGENTS.md",
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
}));

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => undefined),
  loadWorkspaceSkillEntries: vi.fn(() => []),
}));

vi.mock("../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
}));
