import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listSkillCommandsForAgents = vi.hoisted(() => vi.fn());
const parseStrictPositiveInteger = vi.hoisted(() => vi.fn());
const fetchMattermostUserTeams = vi.hoisted(() => vi.fn());
const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const isSlashCommandsEnabled = vi.hoisted(() => vi.fn());
const registerSlashCommands = vi.hoisted(() => vi.fn());
const resolveCallbackUrl = vi.hoisted(() => vi.fn());
const resolveSlashCommandConfig = vi.hoisted(() => vi.fn());
const activateSlashCommands = vi.hoisted(() => vi.fn());

vi.mock("./runtime-api.js", () => ({
  listSkillCommandsForAgents,
  parseStrictPositiveInteger,
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    fetchMattermostUserTeams,
    normalizeMattermostBaseUrl,
  };
});

vi.mock("./slash-commands.js", () => ({
  DEFAULT_COMMAND_SPECS: [
    { description: "ping", trigger: "ping" },
    { description: "duplicate", trigger: "ping" },
  ],
  isSlashCommandsEnabled,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandConfig,
}));

vi.mock("./slash-state.js", () => ({
  activateSlashCommands,
}));

describe("mattermost monitor slash", () => {
  let registerMattermostMonitorSlashCommands: typeof import("./monitor-slash.js").registerMattermostMonitorSlashCommands;

  beforeAll(async () => {
    ({ registerMattermostMonitorSlashCommands } = await import("./monitor-slash.js"));
  });

  beforeEach(() => {
    listSkillCommandsForAgents.mockReset();
    parseStrictPositiveInteger.mockReset();
    fetchMattermostUserTeams.mockReset();
    normalizeMattermostBaseUrl.mockClear();
    isSlashCommandsEnabled.mockReset();
    registerSlashCommands.mockReset();
    resolveCallbackUrl.mockReset();
    resolveSlashCommandConfig.mockReset();
    activateSlashCommands.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns early when slash commands are disabled", async () => {
    resolveSlashCommandConfig.mockReturnValue({ enabled: false });
    isSlashCommandsEnabled.mockReturnValue(false);

    await registerMattermostMonitorSlashCommands({
      account: { config: {} } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
      cfg: {} as never,
      client: {} as never,
      runtime: {} as never,
    });

    expect(fetchMattermostUserTeams).not.toHaveBeenCalled();
    expect(activateSlashCommands).not.toHaveBeenCalled();
  });

  it("registers deduped default and native skill commands across teams", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18888");
    resolveSlashCommandConfig.mockReturnValue({ enabled: true, nativeSkills: true });
    isSlashCommandsEnabled.mockReturnValue(true);
    parseStrictPositiveInteger.mockReturnValue(18_888);
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
    resolveCallbackUrl.mockReturnValue("https://openclaw.test/slash");
    listSkillCommandsForAgents.mockReturnValue([
      { description: "Skill run", name: "skill" },
      { description: "Already prefixed", name: "oc_ping" },
      { description: "ignored", name: "   " },
    ]);
    registerSlashCommands
      .mockResolvedValueOnce([{ token: "token-1", trigger: "ping" }])
      .mockResolvedValueOnce([{ token: "token-2", trigger: "oc_skill" }]);
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await registerMattermostMonitorSlashCommands({
      account: { accountId: "default", config: { commands: {} } } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
      cfg: { gateway: { port: 18_789 } } as never,
      client: {} as never,
      runtime: runtime as never,
    });

    expect(registerSlashCommands).toHaveBeenCalledTimes(2);
    expect(registerSlashCommands.mock.calls[0]?.[0]).toMatchObject({
      callbackUrl: "https://openclaw.test/slash",
      creatorUserId: "bot-user",
      teamId: "team-1",
    });
    expect(registerSlashCommands.mock.calls[0]?.[0].commands).toEqual([
      { description: "ping", trigger: "ping" },
      {
        autoComplete: true,
        autoCompleteHint: "[args]",
        description: "Skill run",
        originalName: "skill",
        trigger: "oc_skill",
      },
      {
        autoComplete: true,
        autoCompleteHint: "[args]",
        description: "Already prefixed",
        originalName: "oc_ping",
        trigger: "oc_ping",
      },
    ]);
    expect(activateSlashCommands).toHaveBeenCalledWith(
      expect.objectContaining({
        commandTokens: ["token-1", "token-2"],
        triggerMap: new Map([
          ["oc_skill", "skill"],
          ["oc_ping", "oc_ping"],
        ]),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "mattermost: slash commands registered (2 commands across 2 teams, callback=https://openclaw.test/slash)",
    );
  });

  it("warns on loopback callback urls and reports partial team failures", async () => {
    resolveSlashCommandConfig.mockReturnValue({ enabled: true, nativeSkills: false });
    isSlashCommandsEnabled.mockReturnValue(true);
    parseStrictPositiveInteger.mockReturnValue(undefined);
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
    resolveCallbackUrl.mockReturnValue("http://127.0.0.1:18789/slash");
    registerSlashCommands
      .mockResolvedValueOnce([{ token: "token-1", trigger: "ping" }])
      .mockRejectedValueOnce(new Error("boom"));
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await registerMattermostMonitorSlashCommands({
      account: { accountId: "default", config: { commands: {} } } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
      cfg: { gateway: { customBindHost: "loopback" } } as never,
      client: {} as never,
      runtime: runtime as never,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "slash commands callbackUrl resolved to http://127.0.0.1:18789/slash",
      ),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: failed to register slash commands for team team-2: Error: boom",
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: slash command registration completed with 1 team error(s)",
    );
  });
});
