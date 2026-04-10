import { ChannelType } from "@buape/carbon";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceCaptureState } from "./capture-state.js";
import { createVoiceReceiveRecoveryState } from "./receive-recovery.js";

const {
  createConnectionMock,
  joinVoiceChannelMock,
  entersStateMock,
  createAudioPlayerMock,
  resolveAgentRouteMock,
  agentCommandMock,
  transcribeAudioFileMock,
  textToSpeechMock,
} = vi.hoisted(() => {
  type EventHandler = (...args: unknown[]) => unknown;
  interface MockConnection {
    destroy: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    receiver: {
      speaking: {
        on: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
      };
      subscribe: ReturnType<typeof vi.fn>;
    };
    state: {
      status: string;
      networking: {
        state: {
          code: string;
          dave: {
            session: {
              setPassthroughMode: ReturnType<typeof vi.fn>;
            };
          };
        };
      };
    };
    daveSetPassthroughMode: ReturnType<typeof vi.fn>;
    handlers: Map<string, EventHandler>;
  }

  const createConnectionMock = (): MockConnection => {
    const handlers = new Map<string, EventHandler>();
    const daveSetPassthroughMode = vi.fn();
    const connection: MockConnection = {
      daveSetPassthroughMode,
      destroy: vi.fn(),
      handlers,
      off: vi.fn(),
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
      }),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn(),
        },
        subscribe: vi.fn(() => ({
          on: vi.fn(),
          destroy: vi.fn(),
          async *[Symbol.asyncIterator]() {},
        })),
      },
      state: {
        networking: {
          state: {
            code: "networking-ready",
            dave: {
              session: {
                setPassthroughMode: daveSetPassthroughMode,
              },
            },
          },
        },
        status: "ready",
      },
      subscribe: vi.fn(),
    };
    return connection;
  };

  return {
    agentCommandMock: vi.fn(async (_opts?: unknown, _runtime?: unknown) => ({ payloads: [] })),
    createAudioPlayerMock: vi.fn(() => ({
      off: vi.fn(),
      on: vi.fn(),
      play: vi.fn(),
      state: { status: "idle" },
      stop: vi.fn(),
    })),
    createConnectionMock,
    entersStateMock: vi.fn(
      async (_target?: unknown, _state?: string, _timeoutMs?: number) => undefined,
    ),
    joinVoiceChannelMock: vi.fn(() => createConnectionMock()),
    resolveAgentRouteMock: vi.fn(() => ({ agentId: "agent-1", sessionKey: "discord:g1:c1" })),
    textToSpeechMock: vi.fn(async () => ({ audioPath: "/tmp/voice.mp3", success: true })),
    transcribeAudioFileMock: vi.fn(async () => ({ text: "hello from voice" })),
  };
});

vi.mock("./sdk-runtime.js", () => ({
  loadDiscordVoiceSdk: () => ({
    AudioPlayerStatus: { Idle: "idle", Playing: "playing" },
    EndBehaviorType: { AfterSilence: "AfterSilence", Manual: "Manual" },
    NetworkingStatusCode: { Ready: "networking-ready", Resuming: "networking-resuming" },
    VoiceConnectionStatus: {
      Connecting: "connecting",
      Destroyed: "destroyed",
      Disconnected: "disconnected",
      Ready: "ready",
      Signalling: "signalling",
    },
    createAudioPlayer: createAudioPlayerMock,
    createAudioResource: vi.fn(),
    entersState: entersStateMock,
    joinVoiceChannel: joinVoiceChannelMock,
  }),
}));

vi.mock("openclaw/plugin-sdk/routing", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/routing")>(
    "openclaw/plugin-sdk/routing",
  );
  return {
    ...actual,
    resolveAgentRoute: resolveAgentRouteMock,
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-runtime")>(
    "openclaw/plugin-sdk/agent-runtime",
  );
  return {
    ...actual,
    agentCommandFromIngress: agentCommandMock,
  };
});

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    mediaUnderstanding: {
      transcribeAudioFile: transcribeAudioFileMock,
    },
    tts: {
      textToSpeech: textToSpeechMock,
    },
  }),
}));

let managerModule: typeof import("./manager.js");

function createClient() {
  return {
    fetchChannel: vi.fn(async (channelId: string) => ({
      guild: { id: "g1", name: "Guild One" },
      guildId: "g1",
      id: channelId,
      type: ChannelType.GuildVoice,
    })),
    fetchGuild: vi.fn(async (guildId: string) => ({
      id: guildId,
      name: "Guild One",
    })),
    fetchMember: vi.fn(),
    fetchUser: vi.fn(),
    getPlugin: vi.fn(() => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn()),
    })),
  };
}

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

describe("DiscordVoiceManager", () => {
  beforeAll(async () => {
    managerModule = await import("./manager.js");
  });

  beforeEach(() => {
    joinVoiceChannelMock.mockReset();
    joinVoiceChannelMock.mockImplementation(() => createConnectionMock());
    entersStateMock.mockReset();
    entersStateMock.mockResolvedValue(undefined);
    createAudioPlayerMock.mockClear();
    resolveAgentRouteMock.mockClear();
    agentCommandMock.mockReset();
    agentCommandMock.mockResolvedValue({ payloads: [] });
    transcribeAudioFileMock.mockReset();
    transcribeAudioFileMock.mockResolvedValue({ text: "hello from voice" });
    textToSpeechMock.mockReset();
    textToSpeechMock.mockResolvedValue({ audioPath: "/tmp/voice.mp3", success: true });
  });

  const createManager = (
    discordConfig: ConstructorParameters<
      typeof managerModule.DiscordVoiceManager
    >[0]["discordConfig"] = {},
    clientOverride?: ReturnType<typeof createClient>,
    cfgOverride: ConstructorParameters<typeof managerModule.DiscordVoiceManager>[0]["cfg"] = {},
  ) =>
    new managerModule.DiscordVoiceManager({
      accountId: "default",
      cfg: cfgOverride,
      client: (clientOverride ?? createClient()) as never,
      discordConfig,
      runtime: createRuntime(),
    });

  const expectConnectedStatus = (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    channelId: string,
  ) => {
    expect(manager.status()).toEqual([
      {
        channelId,
        guildId: "g1",
        message: `connected: guild g1 channel ${channelId}`,
        ok: true,
      },
    ]);
  };

  const emitDecryptFailure = (manager: InstanceType<typeof managerModule.DiscordVoiceManager>) => {
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1");
    expect(entry).toBeDefined();
    (
      manager as unknown as { handleReceiveError: (e: unknown, err: unknown) => void }
    ).handleReceiveError(
      entry,
      new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
    );
  };

  interface ProcessSegmentInvoker {
    processSegment: (params: {
      entry: unknown;
      wavPath: string;
      userId: string;
      durationSeconds: number;
    }) => Promise<void>;
  }

  const processVoiceSegment = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    userId: string,
  ) =>
    await (manager as unknown as ProcessSegmentInvoker).processSegment({
      durationSeconds: 1.2,
      entry: {
        capture: createVoiceCaptureState(),
        channelId: "1001",
        connection: createConnectionMock(),
        guildId: "g1",
        playbackQueue: Promise.resolve(),
        player: createAudioPlayerMock(),
        processingQueue: Promise.resolve(),
        receiveRecovery: createVoiceReceiveRecoveryState(),
        route: { agentId: "agent-1", sessionKey: "discord:g1:1001" },
      },
      userId,
      wavPath: "/tmp/test.wav",
    });

  it("keeps the new session when an old disconnected handler fires", async () => {
    const oldConnection = createConnectionMock();
    const newConnection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
    entersStateMock.mockImplementation(async (target: unknown, status?: string) => {
      if (target === oldConnection && (status === "signalling" || status === "connecting")) {
        throw new Error("old disconnected");
      }
      return undefined;
    });

    const manager = createManager();

    await manager.join({ channelId: "1001", guildId: "g1" });
    await manager.join({ channelId: "1002", guildId: "g1" });

    const oldDisconnected = oldConnection.handlers.get("disconnected");
    expect(oldDisconnected).toBeTypeOf("function");
    await oldDisconnected?.();

    expectConnectedStatus(manager, "1002");
  });

  it("keeps the new session when an old destroyed handler fires", async () => {
    const oldConnection = createConnectionMock();
    const newConnection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);

    const manager = createManager();

    await manager.join({ channelId: "1001", guildId: "g1" });
    await manager.join({ channelId: "1002", guildId: "g1" });

    const oldDestroyed = oldConnection.handlers.get("destroyed");
    expect(oldDestroyed).toBeTypeOf("function");
    oldDestroyed?.();

    expectConnectedStatus(manager, "1002");
  });

  it("removes voice listeners on leave", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ channelId: "1001", guildId: "g1" });
    await manager.leave({ guildId: "g1" });

    const player = createAudioPlayerMock.mock.results[0]?.value;
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith("start", expect.any(Function));
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith("end", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
    expect(player.off).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("passes DAVE options to joinVoiceChannel", async () => {
    const manager = createManager({
      voice: {
        daveEncryption: false,
        decryptionFailureTolerance: 8,
      },
    });

    await manager.join({ channelId: "1001", guildId: "g1" });

    expect(joinVoiceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daveEncryption: false,
        decryptionFailureTolerance: 8,
      }),
    );
  });

  it("keeps the shorter timeout for initial voice connection readiness", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ channelId: "1001", guildId: "g1" });

    expect(entersStateMock).toHaveBeenCalledWith(connection, "ready", 15_000);
  });

  it("stores guild metadata on joined voice sessions", async () => {
    const manager = createManager();

    await manager.join({ channelId: "1001", guildId: "g1" });

    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | { guildName?: string }
      | undefined;
    expect(entry?.guildName).toBe("Guild One");
  });

  it("enables DAVE receive passthrough after join", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ channelId: "1001", guildId: "g1" });

    expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 30);
  });

  it("re-arms passthrough but still rejoin-recovers after repeated decrypt failures", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock
      .mockReturnValueOnce(connection)
      .mockReturnValueOnce(createConnectionMock());
    const manager = createManager();

    await manager.join({ channelId: "1001", guildId: "g1" });
    connection.daveSetPassthroughMode.mockClear();

    emitDecryptFailure(manager);
    emitDecryptFailure(manager);
    emitDecryptFailure(manager);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 15);
    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
  });

  it("allows the same speaker to restart after finalize fires", async () => {
    vi.useFakeTimers();
    try {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ channelId: "1001", guildId: "g1" });

      const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
        | {
            guildId: string;
            channelId: string;
            capture: {
              activeSpeakers: Set<string>;
              activeCaptureStreams: Map<
                string,
                { generation: number; stream: { destroy: () => void } }
              >;
              captureFinalizeTimers: Map<string, unknown>;
              captureGenerations: Map<string, number>;
            };
          }
        | undefined;
      expect(entry).toBeDefined();

      const firstStream = { destroy: vi.fn() };
      entry?.capture.activeSpeakers.add("u1");
      entry?.capture.captureGenerations.set("u1", 1);
      entry?.capture.activeCaptureStreams.set("u1", { generation: 1, stream: firstStream });

      (
        manager as unknown as {
          scheduleCaptureFinalize: (entry: unknown, userId: string, reason: string) => void;
        }
      ).scheduleCaptureFinalize(entry, "u1", "test");

      await vi.advanceTimersByTimeAsync(1200);

      expect(firstStream.destroy).toHaveBeenCalledTimes(1);
      expect(entry?.capture.activeSpeakers.has("u1")).toBe(false);

      const secondStream = {
        on: vi.fn(),
        destroy: vi.fn(),
        async *[Symbol.asyncIterator]() {},
      };
      connection.receiver.subscribe.mockReturnValueOnce(secondStream);

      await (
        manager as unknown as {
          handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
        }
      ).handleSpeakingStart(entry, "u1");

      expect(connection.receiver.subscribe).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ end: { behavior: "Manual" } }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes senderIsOwner=true for allowlisted voice speakers", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Owner Nick",
      user: {
        discriminator: "1234",
        globalName: "Owner",
        id: "u-owner",
        username: "owner",
      },
    });
    const manager = createManager({ allowFrom: ["discord:u-owner"], groupPolicy: "open" }, client);
    await processVoiceSegment(manager, "u-owner");

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(commandArgs?.senderIsOwner).toBe(true);
  });

  it("passes senderIsOwner=false for non-owner voice speakers", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Guest Nick",
      user: {
        discriminator: "4321",
        globalName: "Guest",
        id: "u-guest",
        username: "guest",
      },
    });
    const manager = createManager({ allowFrom: ["discord:u-owner"], groupPolicy: "open" }, client, {
      commands: { useAccessGroups: false },
    });
    await processVoiceSegment(manager, "u-guest");

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(commandArgs?.senderIsOwner).toBe(false);
  });

  it("reuses speaker context cache for repeated segments from the same speaker", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Cached Speaker",
      user: {
        discriminator: "1111",
        globalName: "Cache",
        id: "u-cache",
        username: "cache",
      },
    });
    const manager = createManager({ allowFrom: ["discord:u-cache"] }, client);
    const runSegment = async () => await processVoiceSegment(manager, "u-cache");

    await runSegment();
    await runSegment();

    expect(client.fetchMember).toHaveBeenCalledTimes(3);
  });

  it("persists full speaker context in cache writes", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Role Speaker",
      roles: ["role-voice"],
      user: {
        discriminator: "2222",
        globalName: "Role",
        id: "u-role",
        username: "role",
      },
    });
    const manager = createManager(
      {
        groupPolicy: "allowlist",
        guilds: {
          g1: {
            channels: {
              "1001": {
                roles: ["role:role-voice"],
              },
            },
          },
        },
      },
      client,
    );

    await processVoiceSegment(manager, "u-role");

    const cache = (
      manager as unknown as {
        speakerContextCache: Map<
          string,
          {
            id?: string;
            label: string;
            name?: string;
            tag?: string;
            senderIsOwner: boolean;
            expiresAt: number;
          }
        >;
      }
    ).speakerContextCache;
    const cached = cache.get("g1:u-role");

    expect(cached).toEqual(
      expect.objectContaining({
        id: "u-role",
        label: "Role Speaker",
      }),
    );
  });

  it("re-fetches member roles for repeated voice auth checks", async () => {
    const client = createClient();
    client.fetchMember
      .mockResolvedValueOnce({
        nickname: "Role Speaker",
        roles: ["role-voice"],
        user: {
          discriminator: "2222",
          globalName: "Role",
          id: "u-role",
          username: "role",
        },
      })
      .mockResolvedValueOnce({
        nickname: "Role Speaker",
        roles: ["role-voice"],
        user: {
          discriminator: "2222",
          globalName: "Role",
          id: "u-role",
          username: "role",
        },
      })
      .mockResolvedValueOnce({
        nickname: "Role Speaker",
        roles: [],
        user: {
          discriminator: "2222",
          globalName: "Role",
          id: "u-role",
          username: "role",
        },
      })
      .mockResolvedValue({
        nickname: "Role Speaker",
        roles: [],
        user: {
          discriminator: "2222",
          globalName: "Role",
          id: "u-role",
          username: "role",
        },
      });
    const manager = createManager(
      {
        groupPolicy: "allowlist",
        guilds: {
          g1: {
            channels: {
              "1001": {
                roles: ["role:role-voice"],
              },
            },
          },
        },
      },
      client,
    );

    await processVoiceSegment(manager, "u-role");
    await processVoiceSegment(manager, "u-role");

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(client.fetchMember).toHaveBeenCalledTimes(3);
  });

  it("fetches guild metadata before allowlist checks when the session lacks a guild name", async () => {
    const client = createClient();
    client.fetchGuild.mockResolvedValue({ id: "g1", name: "Guild One" });
    client.fetchMember.mockResolvedValue({
      nickname: "Owner Nick",
      user: {
        discriminator: "1234",
        globalName: "Owner",
        id: "u-owner",
        username: "owner",
      },
    });
    const manager = createManager(
      {
        groupPolicy: "allowlist",
        guilds: {
          "guild-one": {
            channels: {
              "*": {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      },
      client,
    );

    await processVoiceSegment(manager, "u-owner");

    expect(client.fetchGuild).toHaveBeenCalledWith("g1");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  });

  it("DiscordVoiceReadyListener: propagates autoJoin errors fire-and-forget without throwing", async () => {
    const manager = createManager();
    const autoJoinSpy = vi
      .spyOn(manager, "autoJoin")
      .mockRejectedValue(new Error("autoJoin rejected"));

    const { DiscordVoiceReadyListener } = managerModule;
    const listener = new DiscordVoiceReadyListener(manager);

    await expect(listener.handle(undefined, undefined as never)).resolves.not.toThrow();
    expect(autoJoinSpy).toHaveBeenCalledTimes(1);
  });
});
