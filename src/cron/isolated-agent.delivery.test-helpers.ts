import { expect, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { CliDeps } from "../cli/deps.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob } from "./isolated-agent.test-harness.js";

export function createCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    sendMessageDiscord: vi.fn().mockResolvedValue({ channelId: "123", messageId: "discord-1" }),
    sendMessageIMessage: vi.fn().mockResolvedValue({ chatId: "123", messageId: "imessage-1" }),
    sendMessageSignal: vi.fn().mockResolvedValue({ conversationId: "123", messageId: "signal-1" }),
    sendMessageSlack: vi.fn().mockResolvedValue({ channel: "C1", messageTs: "slack-1" }),
    sendMessageTelegram: vi.fn().mockResolvedValue({ chatId: "123", messageId: "tg-1" }),
    sendMessageWhatsApp: vi
      .fn()
      .mockResolvedValue({ messageId: "wa-1", toJid: "123@s.whatsapp.net" }),
    ...overrides,
  };
}

export function mockAgentPayloads(
  payloads: Record<string, unknown>[],
  extra: Partial<Awaited<ReturnType<typeof runEmbeddedPiAgent>>> = {},
): void {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    meta: {
      agentMeta: { model: "m", provider: "p", sessionId: "s" },
      durationMs: 5,
    },
    payloads,
    ...extra,
  });
}

export function expectDirectTelegramDelivery(
  deps: CliDeps,
  params: { chatId: string; text: string; messageThreadId?: number },
) {
  expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
  expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
    params.chatId,
    params.text,
    expect.objectContaining(
      params.messageThreadId === undefined ? {} : { messageThreadId: params.messageThreadId },
    ),
  );
}

export async function runTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  delivery: {
    mode: "announce";
    channel: string;
    to?: string;
    bestEffort?: boolean;
  };
  deliveryContract?: "cron-owned" | "shared";
}): Promise<Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>> {
  return runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath, {
      channels: { telegram: { botToken: "t-1" } },
    }),
    deliveryContract: params.deliveryContract,
    deps: params.deps,
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      delivery: params.delivery,
    },
    lane: "cron",
    message: "do it",
    sessionKey: "cron:job-1",
  });
}
