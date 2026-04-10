import { type IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk/mattermost";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";

const mockState = vi.hoisted(() => ({
  authorizeMattermostCommandInvocation: vi.fn(() => ({
    channelDisplay: "Town Square",
    channelInfo: { display_name: "Town Square", id: "chan-1", name: "town-square", type: "O" },
    channelName: "town-square",
    chatType: "channel",
    commandAuthorized: true,
    kind: "channel",
    ok: true,
    roomLabel: "#town-square",
  })),
  buildModelsProviderData: vi.fn(async () => ({ modelNames: new Map(), providers: [] })),
  createMattermostClient: vi.fn(() => ({})),
  fetchMattermostChannel: vi.fn(async () => ({
    display_name: "Town Square",
    id: "chan-1",
    name: "town-square",
    type: "O",
  })),
  normalizeMattermostAllowList: vi.fn((value: unknown) => value),
  parseSlashCommandPayload: vi.fn(() => ({
    channel_id: "chan-1",
    command: "/oc_models",
    team_id: "team-1",
    text: "models",
    token: "valid-token",
    user_id: "user-1",
    user_name: "alice",
  })),
  readRequestBodyWithLimit: vi.fn(async () => "token=valid-token"),
  resolveCommandText: vi.fn((_trigger: string, text: string) => text),
  resolveMattermostModelPickerEntry: vi.fn(() => ({ kind: "summary" })),
  sendMessageMattermost: vi.fn(async () => ({ channelId: "chan-1", messageId: "post-1" })),
}));

vi.mock("./runtime-api.js", () => ({
    buildModelsProviderData: mockState.buildModelsProviderData,
    createChannelReplyPipeline: vi.fn(() => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
    })),
    createDedupeCache: vi.fn(() => ({
      check: () => false,
    })),
    createReplyPrefixOptions: vi.fn(() => ({})),
    createTypingCallbacks: vi.fn(() => ({ onReplyStart: vi.fn() })),
    formatInboundFromLabel: vi.fn(() => ""),
    isRequestBodyLimitError: vi.fn(() => false),
    logTypingFailure: vi.fn(),
    rawDataToString: vi.fn((value: unknown) => String(value ?? "")),
    readRequestBodyWithLimit: mockState.readRequestBodyWithLimit,
    resolveThreadSessionKeys: vi.fn((params: { baseSessionKey: string }) => ({
      sessionKey: params.baseSessionKey,
      parentSessionKey: undefined,
    })),
  }));

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    channel: {
      commands: {
        shouldHandleTextCommands: () => true,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          accountId: "default",
          agentId: "agent-1",
          sessionKey: "mattermost:session:1",
        })),
      },
      text: {
        hasControlCommand: () => false,
      },
    },
  }),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: mockState.createMattermostClient,
    fetchMattermostChannel: mockState.fetchMattermostChannel,
    normalizeMattermostBaseUrl: vi.fn((value: string | undefined) => value?.trim() ?? ""),
    sendMattermostTyping: vi.fn(),
  };
});

vi.mock("./model-picker.js", () => ({
  renderMattermostModelSummaryView: vi.fn(),
  renderMattermostModelsPickerView: vi.fn(),
  renderMattermostProviderPickerView: vi.fn(),
  resolveMattermostModelPickerCurrentModel: vi.fn(),
  resolveMattermostModelPickerEntry: mockState.resolveMattermostModelPickerEntry,
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: mockState.authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList: mockState.normalizeMattermostAllowList,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverMattermostReplyPayload: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMattermost: mockState.sendMessageMattermost,
}));

vi.mock("./slash-commands.js", () => ({
  parseSlashCommandPayload: mockState.parseSlashCommandPayload,
  resolveCommandText: mockState.resolveCommandText,
}));

let createSlashCommandHttpHandler: typeof import("./slash-http.js").createSlashCommandHttpHandler;

function createRequest(body = "token=valid-token"): IncomingMessage {
  const req = new PassThrough();
  const incoming = req as PassThrough & IncomingMessage;
  incoming.method = "POST";
  incoming.headers = {
    "content-type": "application/x-www-form-urlencoded",
  };
  process.nextTick(() => {
    req.end(body);
  });
  return incoming;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
} {
  let body = "";
  class TestServerResponse extends ServerResponse {
    override setHeader() {
      return this;
    }

    override end(): this;
    override end(cb: () => void): this;
    override end(chunk: string | Buffer | Uint8Array, cb?: () => void): this;
    override end(
      chunk: string | Buffer | Uint8Array,
      encoding: BufferEncoding,
      cb?: () => void,
    ): this;
    override end(
      chunkOrCb?: string | Buffer | Uint8Array | (() => void),
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): this {
      const chunk = typeof chunkOrCb === "function" ? undefined : chunkOrCb;
      const callback =
        typeof chunkOrCb === "function"
          ? chunkOrCb
          : (typeof encodingOrCb === "function"
            ? encodingOrCb
            : cb);
      body = chunk ? String(chunk) : "";
      callback?.();
      return this;
    }
  }

  const res = new TestServerResponse(createRequest(""));
  return {
    getBody: () => body,
    res,
  };
}

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  baseUrl: "https://chat.example.com",
  baseUrlSource: "config",
  botToken: "bot-token",
  botTokenSource: "config",
  config: {},
  enabled: true,
};

describe("slash-http cfg threading", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockState.readRequestBodyWithLimit.mockClear();
    mockState.parseSlashCommandPayload.mockClear();
    mockState.resolveCommandText.mockClear();
    mockState.buildModelsProviderData.mockClear();
    mockState.resolveMattermostModelPickerEntry.mockClear();
    mockState.authorizeMattermostCommandInvocation.mockClear();
    mockState.createMattermostClient.mockClear();
    mockState.fetchMattermostChannel.mockClear();
    mockState.sendMessageMattermost.mockClear();
    mockState.normalizeMattermostAllowList.mockClear();
    ({ createSlashCommandHttpHandler } = await import("./slash-http.js"));
  });

  it("passes cfg through the no-models slash reply send path", async () => {
    const cfg = {
      channels: {
        mattermost: {
          botToken: "exec:secret-ref",
        },
      },
    } as OpenClawConfig;
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg,
      commandTokens: new Set(["valid-token"]),
      runtime: {} as RuntimeEnv,
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Processing");
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "No models available.",
      expect.objectContaining({
        accountId: "default",
        cfg,
      }),
    );
  });

  it("does not rely on Set.has for command token validation", async () => {
    const commandTokens = new Set(["valid-token"]);
    const hasSpy = vi.fn(() => {
      throw new Error("Set.has should not be used for slash token validation");
    });
    Object.defineProperty(commandTokens, "has", {
      configurable: true,
      value: hasSpy,
    });

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      commandTokens,
      runtime: {} as RuntimeEnv,
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Processing");
    expect(hasSpy).not.toHaveBeenCalled();
  });
});
