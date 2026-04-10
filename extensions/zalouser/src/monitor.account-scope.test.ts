import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send-mocks.js";
import { __testing } from "./monitor.js";
import "./zalo-js.test-mocks.js";
import { sendMessageZalouserMock } from "./monitor.send-mocks.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

describe("zalouser monitor pairing account scoping", () => {
  it("scopes DM pairing-store reads and pairing requests to accountId", async () => {
    const readAllowFromStore = vi.fn(
      async (
        channelOrParams:
          | string
          | {
              channel?: string;
              accountId?: string;
            },
        _env?: NodeJS.ProcessEnv,
        accountId?: string,
      ) => {
        const scopedAccountId =
          typeof channelOrParams === "object" && channelOrParams !== null
            ? channelOrParams.accountId
            : accountId;
        return scopedAccountId === "beta" ? [] : ["attacker"];
      },
    );
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIRME88", created: true }));

    setZalouserRuntime({
      channel: {
        commands: {
          isControlCommandMessage: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          shouldComputeCommandAuthorized: vi.fn(() => false),
        },
        pairing: {
          buildPairingReply: vi.fn(() => "pairing reply"),
          readAllowFromStore,
          upsertPairingRequest,
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime);

    const account: ResolvedZalouserAccount = {
      accountId: "beta",
      authenticated: true,
      config: {
        allowFrom: [],
        dmPolicy: "pairing",
      },
      enabled: true,
      profile: "beta",
    };

    const config: OpenClawConfig = {
      channels: {
        zalouser: {
          accounts: {
            alpha: { allowFrom: [], dmPolicy: "pairing" },
            beta: { allowFrom: [], dmPolicy: "pairing" },
          },
        },
      },
    };

    const message: ZaloInboundMessage = {
      content: "hello",
      groupName: undefined,
      isGroup: false,
      msgId: "msg-1",
      raw: { source: "test" },
      senderId: "attacker",
      senderName: "Attacker",
      threadId: "chat-1",
      timestampMs: Date.now(),
    };

    await __testing.processMessage({
      account,
      config,
      message,
      runtime: createZalouserRuntimeEnv(),
    });

    expect(readAllowFromStore).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "beta",
        channel: "zalouser",
      }),
    );
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "beta",
        channel: "zalouser",
        id: "attacker",
      }),
    );
    expect(sendMessageZalouserMock).toHaveBeenCalled();
  });
});
