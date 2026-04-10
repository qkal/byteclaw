import { beforeEach, describe, expect, it, vi } from "vitest";

const searchSkillsFromClawHubMock = vi.fn();
const fetchClawHubSkillDetailMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/skills-clawhub.js", () => ({
  installSkillFromClawHub: vi.fn(),
  searchSkillsFromClawHub: (...args: unknown[]) => searchSkillsFromClawHubMock(...args),
  updateSkillsFromClawHub: vi.fn(),
}));

vi.mock("../../infra/clawhub.js", () => ({
  downloadClawHubSkillArchive: vi.fn(),
  fetchClawHubSkillDetail: (...args: unknown[]) => fetchClawHubSkillDetailMock(...args),
  resolveClawHubBaseUrl: vi.fn(() => "https://clawhub.ai"),
  searchClawHubSkills: vi.fn(),
}));

vi.mock("../../agents/skills-install.js", () => ({
  installSkill: vi.fn(),
}));

const { skillsHandlers } = await import("./skills.js");

function callHandler(method: string, params: Record<string, unknown>) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  const result = skillsHandlers[method]({
    client: null as never,
    context: {} as never,
    isWebchatConnect: () => false,
    params,
    req: {} as never,
    respond: (success: boolean, res: unknown, err: unknown) => {
      ok = success;
      response = res;
      error = err;
    },
  });
  return Promise.resolve(result).then(() => ({ error, ok, response }));
}

describe("skills.search handler", () => {
  beforeEach(() => {
    searchSkillsFromClawHubMock.mockReset();
    fetchClawHubSkillDetailMock.mockReset();
  });

  it("searches ClawHub with query and limit", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        displayName: "GitHub",
        score: 0.95,
        slug: "github",
        summary: "GitHub integration",
        updatedAt: 1_700_000_000,
        version: "1.0.0",
      },
    ]);

    const { ok, response, error } = await callHandler("skills.search", {
      limit: 10,
      query: "github",
    });

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      limit: 10,
      query: "github",
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toEqual({
      results: [
        {
          displayName: "GitHub",
          score: 0.95,
          slug: "github",
          summary: "GitHub integration",
          updatedAt: 1_700_000_000,
          version: "1.0.0",
        },
      ],
    });
  });

  it("searches without query (browse all)", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([]);

    const { ok, response } = await callHandler("skills.search", {});

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      limit: undefined,
      query: undefined,
    });
    expect(ok).toBe(true);
    expect(response).toEqual({ results: [] });
  });

  it("returns error when ClawHub is unreachable", async () => {
    searchSkillsFromClawHubMock.mockRejectedValue(new Error("connection refused"));

    const { ok, error } = await callHandler("skills.search", { query: "test" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: "connection refused" });
  });

  it("rejects limit below minimum", async () => {
    const { ok, error } = await callHandler("skills.search", {
      limit: 0,
      query: "test",
    });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
  });

  it("rejects limit above maximum", async () => {
    const { ok, error } = await callHandler("skills.search", {
      limit: 101,
      query: "test",
    });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
  });
});

describe("skills.detail handler", () => {
  beforeEach(() => {
    searchSkillsFromClawHubMock.mockReset();
    fetchClawHubSkillDetailMock.mockReset();
  });

  it("fetches detail for a valid slug", async () => {
    const detail = {
      latestVersion: {
        createdAt: 1_700_000_000,
        version: "1.0.0",
      },
      owner: {
        displayName: "OpenClaw",
        handle: "openclaw",
      },
      skill: {
        createdAt: 1_700_000_000,
        displayName: "GitHub",
        slug: "github",
        summary: "GitHub integration",
        updatedAt: 1_700_000_000,
      },
    };
    fetchClawHubSkillDetailMock.mockResolvedValue(detail);

    const { ok, response, error } = await callHandler("skills.detail", {
      slug: "github",
    });

    expect(fetchClawHubSkillDetailMock).toHaveBeenCalledWith({ slug: "github" });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toEqual(detail);
  });

  it("returns error when slug is not found", async () => {
    fetchClawHubSkillDetailMock.mockRejectedValue(new Error("not found"));

    const { ok, error } = await callHandler("skills.detail", { slug: "nonexistent" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: "not found" });
  });

  it("rejects missing slug", async () => {
    const { ok, error } = await callHandler("skills.detail", {});

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchClawHubSkillDetailMock).not.toHaveBeenCalled();
  });

  it("rejects empty slug", async () => {
    const { ok, error } = await callHandler("skills.detail", { slug: "" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchClawHubSkillDetailMock).not.toHaveBeenCalled();
  });
});
