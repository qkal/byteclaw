import { beforeEach, describe, expect, it } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { matrixMessageActions } from "./actions.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const profileAction = "set-profile" as const;

const runtimeStub = {
  channel: {
    text: {
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
      convertMarkdownTables: (text: string) => text,
      resolveChunkMode: () => "length",
      resolveMarkdownTableMode: () => "code",
      resolveTextChunkLimit: () => 4000,
    },
  },
  config: {
    loadConfig: () => ({}),
  },
  media: {
    getImageMetadata: async () => null,
    isVoiceCompatibleAudio: () => false,
    loadWebMedia: async () => {
      throw new Error("not used");
    },
    mediaKindFromMime: () => "image",
    resizeToJpeg: async () => Buffer.from(""),
  },
  state: {
    resolveStateDir: () => "/tmp/openclaw-matrix-test",
  },
} as unknown as PluginRuntime;

function createConfiguredMatrixConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        accessToken: "token",
        enabled: true,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
      },
    },
  } as CoreConfig;
}

describe("matrixMessageActions", () => {
  beforeEach(() => {
    setMatrixRuntime(runtimeStub);
  });

  it("exposes poll create but only handles poll votes inside the plugin", () => {
    const { describeMessageTool } = matrixMessageActions;
    const supportsAction = matrixMessageActions.supportsAction ?? (() => false);

    expect(describeMessageTool).toBeTypeOf("function");
    expect(supportsAction).toBeTypeOf("function");

    const discovery = describeMessageTool({
      cfg: createConfiguredMatrixConfig(),
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const { actions } = discovery;
    expect(actions).toContain("poll");
    expect(actions).toContain("poll-vote");
    expect(supportsAction({ action: "poll" } as never)).toBe(false);
    expect(supportsAction({ action: "poll-vote" } as never)).toBe(true);
  });

  it("exposes and describes self-profile updates", () => {
    const { describeMessageTool } = matrixMessageActions;
    const supportsAction = matrixMessageActions.supportsAction ?? (() => false);

    const discovery = describeMessageTool({
      cfg: createConfiguredMatrixConfig(),
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const { actions } = discovery;
    const { schema } = discovery;
    if (!schema) {
      throw new Error("matrix schema missing");
    }
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};

    expect(actions).toContain(profileAction);
    expect(supportsAction({ action: profileAction } as never)).toBe(true);
    expect(properties.displayName).toBeDefined();
    expect(properties.avatarUrl).toBeDefined();
    expect(properties.avatarPath).toBeDefined();
  });

  it("hides gated actions when the default Matrix account disables them", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              assistant: {
                accessToken: "token",
                actions: {
                  channelInfo: false,
                  memberInfo: false,
                  messages: false,
                  pins: false,
                  profile: false,
                  reactions: false,
                  verification: false,
                },
                encryption: true,
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
              },
            },
            actions: {
              channelInfo: true,
              memberInfo: true,
              messages: true,
              pins: true,
              profile: true,
              reactions: true,
              verification: true,
            },
            defaultAccount: "assistant",
          },
        },
      } as CoreConfig,
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const { actions } = discovery;

    expect(actions).toEqual(["poll", "poll-vote"]);
  });

  it("hides actions until defaultAccount is set for ambiguous multi-account configs", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              assistant: {
                accessToken: "assistant-token",
                homeserver: "https://matrix.example.org",
              },
              ops: {
                accessToken: "ops-token",
                homeserver: "https://matrix.example.org",
              },
            },
          },
        },
      } as CoreConfig,
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const { actions } = discovery;

    expect(actions).toEqual([]);
  });

  it("honors the selected Matrix account during discovery", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            assistant: {
              accessToken: "assistant-token",
              actions: {
                messages: true,
                reactions: false,
              },
              homeserver: "https://matrix.example.org",
              userId: "@assistant:example.org",
            },
            ops: {
              accessToken: "ops-token",
              actions: {
                messages: true,
                reactions: true,
              },
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
            },
          },
          defaultAccount: "assistant",
        },
      },
    } as CoreConfig;

    const { describeMessageTool } = matrixMessageActions;
    if (!describeMessageTool) {
      throw new Error("matrix message action discovery is unavailable");
    }

    const assistantDiscovery = describeMessageTool({
      accountId: "assistant",
      cfg,
    } as never);
    const opsDiscovery = describeMessageTool({
      accountId: "ops",
      cfg,
    } as never);

    if (!assistantDiscovery || !opsDiscovery) {
      throw new Error("matrix action discovery returned null");
    }

    const assistantActions = assistantDiscovery.actions;
    const opsActions = opsDiscovery.actions;

    expect(assistantActions).not.toContain("react");
    expect(assistantActions).not.toContain("reactions");
    expect(opsActions).toContain("react");
    expect(opsActions).toContain("reactions");
  });
});
