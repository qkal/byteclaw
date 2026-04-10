import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import {
  createActivityHandler as baseCreateActivityHandler,
  createMSTeamsMessageHandlerDeps,
} from "./monitor-handler.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { createMSTeamsSsoTokenStoreMemory } from "./sso-token-store.js";
import {
  type MSTeamsSsoFetch,
  handleSigninTokenExchangeInvoke,
  handleSigninVerifyStateInvoke,
  parseSigninTokenExchangeValue,
  parseSigninVerifyStateValue,
} from "./sso.js";

function installTestRuntime(): void {
  setMSTeamsRuntime({
    channel: {
      debounce: {
        createInboundDebouncer: <T>(params: {
          onFlush: (entries: T[]) => Promise<void>;
        }): { enqueue: (entry: T) => Promise<void> } => ({
          enqueue: async (entry: T) => {
            await params.onFlush([entry]);
          },
        }),
        resolveInboundDebounceMs: () => 0,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
      reply: {
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        formatAgentEnvelope: ({ body }: { body: string }) => body,
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          accountId: "default",
          agentId: "default",
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
        }),
      },
      session: {
        recordInboundSession: vi.fn(async () => undefined),
      },
      text: {
        hasControlCommand: () => false,
      },
    },
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: vi.fn() },
  } as unknown as PluginRuntime);
}

function createActivityHandler() {
  const run = vi.fn(async () => undefined);
  const handler = baseCreateActivityHandler(run);
  return { handler, run };
}

function createDepsWithoutSso(
  overrides: Partial<MSTeamsMessageHandlerDeps> = {},
): MSTeamsMessageHandlerDeps {
  const base = createMSTeamsMessageHandlerDeps();
  return { ...base, ...overrides };
}

function createSsoDeps(params: { fetchImpl: MSTeamsSsoFetch }) {
  const tokenStore = createMSTeamsSsoTokenStoreMemory();
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "bf-service-token"),
  };
  return {
    sso: {
      connectionName: "GraphConnection",
      fetchImpl: params.fetchImpl,
      tokenProvider,
      tokenStore,
    },
    tokenProvider,
    tokenStore,
  };
}

function createSigninInvokeContext(params: {
  name: "signin/tokenExchange" | "signin/verifyState";
  value: unknown;
  userAadId?: string;
  userBfId?: string;
}): MSTeamsTurnContext & { sendActivity: ReturnType<typeof vi.fn> } {
  return {
    activity: {
      attachments: [],
      channelData: {},
      channelId: "msteams",
      conversation: {
        conversationType: "personal",
        id: "19:personal-chat",
      },
      from: {
        aadObjectId: params.userAadId ?? "aad-user-guid",
        id: params.userBfId ?? "bf-user",
        name: "Test User",
      },
      id: "invoke-1",
      name: params.name,
      recipient: { id: "bot-id", name: "Bot" },
      serviceUrl: "https://service.example.test",
      type: "invoke",
      value: params.value,
    },
    deleteActivity: vi.fn(async () => {}),
    sendActivities: vi.fn(async () => []),
    sendActivity: vi.fn(async () => ({ id: "ack-id" })),
    updateActivity: vi.fn(async () => ({ id: "update" })),
  } as unknown as MSTeamsTurnContext & {
    sendActivity: ReturnType<typeof vi.fn>;
  };
}

function createFakeFetch(handlers: ((url: string, init?: unknown) => unknown)[]) {
  const calls: { url: string; init?: unknown }[] = [];
  const fetchImpl: MSTeamsSsoFetch = async (url, init) => {
    calls.push({ init, url });
    const handler = handlers.shift();
    if (!handler) {
      throw new Error("unexpected fetch call");
    }
    const response = handler(url, init) as {
      ok: boolean;
      status: number;
      body: unknown;
    };
    return {
      json: async () => response.body,
      ok: response.ok,
      status: response.status,
      text: async () =>
        typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? ""),
    };
  };
  return { calls, fetchImpl };
}

describe("msteams signin invoke value parsers", () => {
  it("parses signin/tokenExchange values", () => {
    expect(
      parseSigninTokenExchangeValue({
        connectionName: "Graph",
        id: "flow-1",
        token: "eyJ...",
      }),
    ).toEqual({ connectionName: "Graph", id: "flow-1", token: "eyJ..." });
  });

  it("rejects non-object signin/tokenExchange values", () => {
    expect(parseSigninTokenExchangeValue(null)).toBeNull();
    expect(parseSigninTokenExchangeValue("nope")).toBeNull();
  });

  it("parses signin/verifyState values", () => {
    expect(parseSigninVerifyStateValue({ state: "123456" })).toEqual({ state: "123456" });
    expect(parseSigninVerifyStateValue({})).toEqual({ state: undefined });
    expect(parseSigninVerifyStateValue(null)).toBeNull();
  });
});

describe("handleSigninTokenExchangeInvoke", () => {
  it("exchanges the Teams token and persists the result", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          expiration: "2030-01-01T00:00:00Z",
          token: "delegated-graph-token",
        },
        ok: true,
        status: 200,
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      deps: sso,
      user: { channelId: "msteams", userId: "aad-user-guid" },
      value: { connectionName: "GraphConnection", id: "flow-1", token: "exchangeable-token" },
    });

    expect(result).toEqual({
      expiresAt: "2030-01-01T00:00:00Z",
      ok: true,
      token: "delegated-graph-token",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/usertoken/exchange");
    expect(calls[0]?.url).toContain("userId=aad-user-guid");
    expect(calls[0]?.url).toContain("connectionName=GraphConnection");
    expect(calls[0]?.url).toContain("channelId=msteams");

    const init = calls[0]?.init as {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer bf-service-token");
    expect(JSON.parse(init?.body ?? "{}")).toEqual({ token: "exchangeable-token" });

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-graph-token");
    expect(stored?.expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  it("returns a service error when the User Token service rejects the exchange", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({ body: "bad gateway", ok: false, status: 502 }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      deps: sso,
      user: { channelId: "msteams", userId: "aad-user-guid" },
      value: { connectionName: "GraphConnection", id: "flow-1", token: "exchangeable-token" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_error");
      expect(result.status).toBe(502);
      expect(result.message).toContain("bad gateway");
    }
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored).toBeNull();
  });

  it("refuses to exchange without a user id", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      deps: sso,
      user: { channelId: "msteams", userId: "" },
      value: { connectionName: "GraphConnection", id: "flow-1", token: "exchangeable-token" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_user");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("handleSigninVerifyStateInvoke", () => {
  it("fetches the user token for the magic code and persists it", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          expiration: "2031-02-03T04:05:06Z",
          token: "delegated-token-2",
        },
        ok: true,
        status: 200,
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninVerifyStateInvoke({
      deps: sso,
      user: { channelId: "msteams", userId: "aad-user-guid" },
      value: { state: "654321" },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain("/api/usertoken/GetToken");
    expect(calls[0]?.url).toContain("code=654321");
    const init = calls[0]?.init as { method?: string };
    expect(init?.method).toBe("GET");

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-token-2");
  });

  it("rejects invocations without a state code", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });
    const result = await handleSigninVerifyStateInvoke({
      deps: sso,
      user: { channelId: "msteams", userId: "aad-user-guid" },
      value: { state: "   " },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_state");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("msteams signin invoke handler registration", () => {
  beforeAll(() => {
    installTestRuntime();
  });

  it("acks signin invokes even when sso is not configured", async () => {
    const deps = createDepsWithoutSso();
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { connectionName: "Graph", id: "x", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
        value: expect.objectContaining({ status: 200 }),
      }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(deps.log.debug).toHaveBeenCalledWith(
      "signin invoke received but msteams.sso is not configured",
      expect.objectContaining({ name: "signin/tokenExchange" }),
    );
  });

  it("invokes the token exchange handler when sso is configured", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          expiration: "2030-01-01T00:00:00Z",
          token: "delegated-graph-token",
        },
        ok: true,
        status: 200,
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { connectionName: "GraphConnection", id: "x", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
        value: expect.objectContaining({ status: 200 }),
      }),
    );
    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso token exchanged",
      expect.objectContaining({ hasExpiry: true, userId: "aad-user-guid" }),
    );
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-graph-token");
  });

  it("logs an error when the token exchange fails", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({ body: "bad request", ok: false, status: 400 }),
    ]);
    const { sso } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { connectionName: "GraphConnection", id: "x", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "invokeResponse" }),
    );
    expect(deps.log.error).toHaveBeenCalledWith(
      "msteams sso token exchange failed",
      expect.objectContaining({ code: "unexpected_response", status: 400 }),
    );
  });

  it("handles signin/verifyState via the magic-code flow", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-3",
        },
        ok: true,
        status: 200,
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/verifyState",
      value: { state: "112233" },
    });

    await registered.run(ctx);

    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso verifyState succeeded",
      expect.objectContaining({ userId: "aad-user-guid" }),
    );
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-token-3");
  });
});
