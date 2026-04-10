import { type Mock, expect, vi } from "vitest";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;

interface DiscordOutboundHoisted {
  sendMessageDiscordMock: AsyncUnknownMock;
  sendDiscordComponentMessageMock: AsyncUnknownMock;
  sendPollDiscordMock: AsyncUnknownMock;
  sendWebhookMessageDiscordMock: AsyncUnknownMock;
  getThreadBindingManagerMock: UnknownMock;
}

type DiscordSendModule = typeof import("./send.js");
type DiscordSendComponentsModule = typeof import("./send.components.js");
type DiscordThreadBindingsModule = typeof import("./monitor/thread-bindings.js");

function invokeMock<TArgs extends unknown[], TResult>(
  mock: (...args: unknown[]) => unknown,
  ...args: TArgs
): TResult {
  return mock(...args) as TResult;
}

export function createDiscordOutboundHoisted(): DiscordOutboundHoisted {
  const sendMessageDiscordMock = vi.fn();
  const sendDiscordComponentMessageMock = vi.fn();
  const sendPollDiscordMock = vi.fn();
  const sendWebhookMessageDiscordMock = vi.fn();
  const getThreadBindingManagerMock = vi.fn();
  return {
    getThreadBindingManagerMock,
    sendDiscordComponentMessageMock,
    sendMessageDiscordMock,
    sendPollDiscordMock,
    sendWebhookMessageDiscordMock,
  };
}

export const DEFAULT_DISCORD_SEND_RESULT = {
  channel: "discord",
  channelId: "ch-1",
  messageId: "msg-1",
} as const;

export async function createDiscordSendModuleMock(
  hoisted: DiscordOutboundHoisted,
  loadActual: () => Promise<DiscordSendModule>,
): Promise<DiscordSendModule> {
  const actual = await loadActual();
  return {
    ...actual,
    sendMessageDiscord: (...args: Parameters<DiscordSendModule["sendMessageDiscord"]>) =>
      invokeMock<
        Parameters<DiscordSendModule["sendMessageDiscord"]>,
        ReturnType<DiscordSendModule["sendMessageDiscord"]>
      >(hoisted.sendMessageDiscordMock, ...args),
    sendPollDiscord: (...args: Parameters<DiscordSendModule["sendPollDiscord"]>) =>
      invokeMock<
        Parameters<DiscordSendModule["sendPollDiscord"]>,
        ReturnType<DiscordSendModule["sendPollDiscord"]>
      >(hoisted.sendPollDiscordMock, ...args),
    sendWebhookMessageDiscord: (
      ...args: Parameters<DiscordSendModule["sendWebhookMessageDiscord"]>
    ) =>
      invokeMock<
        Parameters<DiscordSendModule["sendWebhookMessageDiscord"]>,
        ReturnType<DiscordSendModule["sendWebhookMessageDiscord"]>
      >(hoisted.sendWebhookMessageDiscordMock, ...args),
  };
}

export async function createDiscordSendComponentsModuleMock(
  hoisted: DiscordOutboundHoisted,
  loadActual: () => Promise<DiscordSendComponentsModule>,
): Promise<DiscordSendComponentsModule> {
  const actual = await loadActual();
  return {
    ...actual,
    sendDiscordComponentMessage: (
      ...args: Parameters<DiscordSendComponentsModule["sendDiscordComponentMessage"]>
    ) =>
      invokeMock<
        Parameters<DiscordSendComponentsModule["sendDiscordComponentMessage"]>,
        ReturnType<DiscordSendComponentsModule["sendDiscordComponentMessage"]>
      >(hoisted.sendDiscordComponentMessageMock, ...args),
  };
}

export async function createDiscordThreadBindingsModuleMock(
  hoisted: DiscordOutboundHoisted,
  loadActual: () => Promise<DiscordThreadBindingsModule>,
): Promise<DiscordThreadBindingsModule> {
  const actual = await loadActual();
  return {
    ...actual,
    getThreadBindingManager: (
      ...args: Parameters<DiscordThreadBindingsModule["getThreadBindingManager"]>
    ) =>
      invokeMock<
        Parameters<DiscordThreadBindingsModule["getThreadBindingManager"]>,
        ReturnType<DiscordThreadBindingsModule["getThreadBindingManager"]>
      >(hoisted.getThreadBindingManagerMock, ...args),
  };
}

export async function installDiscordOutboundModuleSpies(hoisted: DiscordOutboundHoisted) {
  const sendModule = await import("./send.js");
  const mockedSendModule = await createDiscordSendModuleMock(hoisted, async () => sendModule);
  vi.spyOn(sendModule, "sendMessageDiscord").mockImplementation(
    mockedSendModule.sendMessageDiscord,
  );
  vi.spyOn(sendModule, "sendPollDiscord").mockImplementation(mockedSendModule.sendPollDiscord);
  vi.spyOn(sendModule, "sendWebhookMessageDiscord").mockImplementation(
    mockedSendModule.sendWebhookMessageDiscord,
  );

  const sendComponentsModule = await import("./send.components.js");
  const mockedSendComponentsModule = await createDiscordSendComponentsModuleMock(
    hoisted,
    async () => sendComponentsModule,
  );
  vi.spyOn(sendComponentsModule, "sendDiscordComponentMessage").mockImplementation(
    mockedSendComponentsModule.sendDiscordComponentMessage,
  );

  const threadBindingsModule = await import("./monitor/thread-bindings.js");
  const mockedThreadBindingsModule = await createDiscordThreadBindingsModuleMock(
    hoisted,
    async () => threadBindingsModule,
  );
  vi.spyOn(threadBindingsModule, "getThreadBindingManager").mockImplementation(
    mockedThreadBindingsModule.getThreadBindingManager,
  );
}

export function resetDiscordOutboundMocks(hoisted: DiscordOutboundHoisted) {
  hoisted.sendMessageDiscordMock.mockReset().mockResolvedValue({
    channelId: "ch-1",
    messageId: "msg-1",
  });
  hoisted.sendDiscordComponentMessageMock.mockReset().mockResolvedValue({
    channelId: "ch-1",
    messageId: "component-1",
  });
  hoisted.sendPollDiscordMock.mockReset().mockResolvedValue({
    channelId: "ch-1",
    messageId: "poll-1",
  });
  hoisted.sendWebhookMessageDiscordMock.mockReset().mockResolvedValue({
    channelId: "thread-1",
    messageId: "msg-webhook-1",
  });
  hoisted.getThreadBindingManagerMock.mockReset().mockReturnValue(null);
}

export function expectDiscordThreadBotSend(params: {
  hoisted: DiscordOutboundHoisted;
  text: string;
  result: unknown;
  options?: Record<string, unknown>;
}) {
  expect(params.hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
    "channel:thread-1",
    params.text,
    expect.objectContaining({
      accountId: "default",
      ...params.options,
    }),
  );
  expect(params.result).toEqual(DEFAULT_DISCORD_SEND_RESULT);
}

export function mockDiscordBoundThreadManager(hoisted: DiscordOutboundHoisted) {
  hoisted.getThreadBindingManagerMock.mockReturnValue({
    getByThreadId: () => ({
      accountId: "default",
      agentId: "main",
      boundAt: Date.now(),
      boundBy: "system",
      channelId: "parent-1",
      label: "codex-thread",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      threadId: "thread-1",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    }),
  });
}
