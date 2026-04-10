import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAgentsMock = vi.hoisted(() =>
  vi.fn(async (host: { agentsList?: unknown }) => {
    host.agentsList = {
      agents: [{ id: "main" }],
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
    };
  }),
);
const loadConfigMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentIdentitiesMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentIdentityMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentSkillsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentFilesMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadChannelsMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../ui/src/ui/controllers/agents.ts", () => ({
  loadAgents: loadAgentsMock,
}));

vi.mock("../ui/src/ui/controllers/config.ts", () => ({
  loadConfig: loadConfigMock,
  loadConfigSchema: vi.fn(async () => undefined),
}));

vi.mock("../ui/src/ui/controllers/agent-identity.ts", () => ({
  loadAgentIdentities: loadAgentIdentitiesMock,
  loadAgentIdentity: loadAgentIdentityMock,
}));

vi.mock("../ui/src/ui/controllers/agent-skills.ts", () => ({
  loadAgentSkills: loadAgentSkillsMock,
}));

vi.mock("../ui/src/ui/controllers/agent-files.ts", () => ({
  loadAgentFiles: loadAgentFilesMock,
}));

vi.mock("../ui/src/ui/controllers/channels.ts", () => ({
  loadChannels: loadChannelsMock,
}));

vi.mock("../ui/src/ui/controllers/cron.ts", () => ({
  loadCronJobsPage: vi.fn(async () => undefined),
  loadCronRuns: vi.fn(async () => undefined),
  loadCronStatus: vi.fn(async () => undefined),
}));

import { refreshActiveTab } from "../ui/src/ui/app-settings.ts";

type AgentsPanel = "overview" | "files" | "tools" | "skills" | "channels" | "cron";

function createHost(agentsPanel: AgentsPanel): Parameters<typeof refreshActiveTab>[0] {
  return {
    agentsList: null,
    agentsPanel,
    agentsSelectedId: null,
    applySessionKey: "main",
    basePath: "",
    chatHasAutoScrolled: false,
    connected: true,
    dreamDiaryContent: null,
    dreamDiaryError: null,
    dreamDiaryLoading: false,
    dreamDiaryPath: null,
    dreamingModeSaving: false,
    dreamingStatus: null,
    dreamingStatusError: null,
    dreamingStatusLoading: false,
    eventLog: [],
    eventLogBuffer: [],
    logsAtBottom: false,
    sessionKey: "main",
    settings: {
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      gatewayUrl: "",
      lastActiveSessionKey: "main",
      navCollapsed: false,
      navGroupsCollapsed: {},
      navWidth: 220,
      sessionKey: "main",
      splitRatio: 0.6,
      theme: "claw",
      themeMode: "system",
      token: "",
    },
    tab: "agents",
    theme: "claw",
    themeMode: "system",
    themeResolved: "dark",
  } as Parameters<typeof refreshActiveTab>[0];
}

describe("refreshActiveTab (agents/files)", () => {
  beforeEach(() => {
    loadAgentsMock.mockClear();
    loadConfigMock.mockClear();
    loadAgentIdentitiesMock.mockClear();
    loadAgentIdentityMock.mockClear();
    loadAgentSkillsMock.mockClear();
    loadAgentFilesMock.mockClear();
    loadChannelsMock.mockClear();
  });

  it("loads agent files when the active agents panel is files", async () => {
    const host = createHost("files");
    await refreshActiveTab(host);

    expect(loadAgentFilesMock).toHaveBeenCalledTimes(1);
    expect(loadAgentFilesMock).toHaveBeenCalledWith(host, "main");
  });

  it("does not load agent files on non-files panels", async () => {
    const host = createHost("overview");
    await refreshActiveTab(host);

    expect(loadAgentFilesMock).not.toHaveBeenCalled();
  });
});
