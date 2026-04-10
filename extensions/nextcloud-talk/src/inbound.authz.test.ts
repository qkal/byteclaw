import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

function installInboundAuthzRuntime(params: {
  readAllowFromStore: () => Promise<string[]>;
  buildMentionRegexes: () => RegExp[];
}) {
  setNextcloudTalkRuntime({
    channel: {
      commands: {
        shouldHandleTextCommands: () => false,
      },
      mentions: {
        buildMentionRegexes: params.buildMentionRegexes,
        matchesMentionPatterns: () => false,
      },
      pairing: {
        readAllowFromStore: params.readAllowFromStore,
      },
      text: {
        hasControlCommand: () => false,
      },
    },
  } as unknown as PluginRuntime);
}

function createTestRuntimeEnv(): RuntimeEnv {
  return {
    error: vi.fn(),
    log: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("nextcloud-talk inbound authz", () => {
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const readAllowFromStore = vi.fn(async () => ["attacker"]);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    installInboundAuthzRuntime({ buildMentionRegexes, readAllowFromStore });

    const message: NextcloudTalkInboundMessage = {
      isGroupChat: true,
      mediaType: "text/plain",
      messageId: "m-1",
      roomName: "Room 1",
      roomToken: "room-1",
      senderId: "attacker",
      senderName: "Attacker",
      text: "hello",
      timestamp: Date.now(),
    };

    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      enabled: true,
      baseUrl: "",
      secret: "",
      secretSource: "none", // Pragma: allowlist secret
      config: {
        allowFrom: [],
        dmPolicy: "pairing",
        groupAllowFrom: [],
        groupPolicy: "allowlist",
      },
    };

    const config: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          allowFrom: [],
          dmPolicy: "pairing",
          groupAllowFrom: [],
          groupPolicy: "allowlist",
        },
      },
    };

    await handleNextcloudTalkInbound({
      account,
      config,
      message,
      runtime: createTestRuntimeEnv(),
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      accountId: "default",
      channel: "nextcloud-talk",
    });
    expect(buildMentionRegexes).not.toHaveBeenCalled();
  });

  it("matches group rooms by token instead of colliding room names", async () => {
    const readAllowFromStore = vi.fn(async () => []);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    installInboundAuthzRuntime({ buildMentionRegexes, readAllowFromStore });

    const message: NextcloudTalkInboundMessage = {
      isGroupChat: true,
      mediaType: "text/plain",
      messageId: "m-2",
      roomName: "Room Trusted",
      roomToken: "room-attacker",
      senderId: "trusted-user",
      senderName: "Trusted User",
      text: "hello",
      timestamp: Date.now(),
    };

    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      baseUrl: "",
      config: {
        allowFrom: [],
        dmPolicy: "pairing",
        groupAllowFrom: ["trusted-user"],
        groupPolicy: "allowlist",
        rooms: {
          "room-trusted": {
            enabled: true,
          },
        },
      },
      enabled: true,
      secret: "",
      secretSource: "none",
    };

    await handleNextcloudTalkInbound({
      account,
      config: {
        channels: {
          "nextcloud-talk": {
            groupAllowFrom: ["trusted-user"],
            groupPolicy: "allowlist",
          },
        },
      },
      message,
      runtime: createTestRuntimeEnv(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
  });
});
