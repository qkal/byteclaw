import type { IncomingMessage, ServerResponse } from "node:http";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { ResolvedSynologyChatAccount } from "./types.js";

export interface RegisteredRoute {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export const registerPluginHttpRouteMock: Mock<(params: RegisteredRoute) => () => void> = vi.fn(
  () => vi.fn(),
);

export const dispatchReplyWithBufferedBlockDispatcher: Mock<
  () => Promise<{ counts: Record<string, number> }>
> = vi.fn().mockResolvedValue({ counts: {} });
export const finalizeInboundContextMock: Mock<
  (ctx: Record<string, unknown>) => Record<string, unknown>
> = vi.fn((ctx) => ctx);
export const resolveAgentRouteMock: Mock<
  (params: { accountId?: string }) => { agentId: string; sessionKey: string; accountId: string }
> = vi.fn((params) => {
  const accountId = params.accountId?.trim() || "default";
  return {
    accountId,
    agentId: `agent-${accountId}`,
    sessionKey: `agent:agent-${accountId}:main`,
  };
});

async function readRequestBodyWithLimitForTest(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

vi.mock("openclaw/plugin-sdk/setup", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/setup");
  return {
    ...actual,
    DEFAULT_ACCOUNT_ID: "default",
  };
});

vi.mock("openclaw/plugin-sdk/channel-config-schema", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/channel-config-schema");
  return {
    ...actual,
    buildChannelConfigSchema: vi.fn((schema: unknown) => ({ schema })),
  };
});

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/webhook-ingress");
  return {
    ...actual,
    createFixedWindowRateLimiter: vi.fn(() => ({
      clear: vi.fn(),
      isRateLimited: vi.fn(() => false),
      size: vi.fn(() => 0),
    })),
    isRequestBodyLimitError: vi.fn(() => false),
    readRequestBodyWithLimit: vi.fn(readRequestBodyWithLimitForTest),
    registerPluginHttpRoute: registerPluginHttpRouteMock,
    requestBodyErrorToText: vi.fn(() => "Request body too large"),
  };
});

vi.mock("./client.js", () => ({
  resolveLegacyWebhookNameToChatUserId: vi.fn().mockResolvedValue(undefined),
  sendFileUrl: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue(true),
}));

vi.mock("./runtime.js", () => ({
  getSynologyRuntime: vi.fn(() => ({
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        finalizeInboundContext: finalizeInboundContextMock,
      },
      routing: {
        resolveAgentRoute: resolveAgentRouteMock,
      },
    },
    config: { loadConfig: vi.fn().mockResolvedValue({}) },
  })),
  setSynologyRuntime: vi.fn(),
}));

export function makeSecurityAccount(
  overrides: Partial<ResolvedSynologyChatAccount> = {},
): ResolvedSynologyChatAccount {
  return {
    accountId: "default",
    allowInsecureSsl: false,
    allowedUserIds: [],
    botName: "Bot",
    dangerouslyAllowInheritedWebhookPath: false,
    dangerouslyAllowNameMatching: false,
    dmPolicy: "allowlist" as const,
    enabled: true,
    incomingUrl: "https://nas/incoming",
    nasHost: "h",
    rateLimitPerMinute: 30,
    token: "t",
    webhookPath: "/w",
    webhookPathSource: "default",
    ...overrides,
  };
}
