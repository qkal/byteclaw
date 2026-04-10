import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { runBeforeToolCallHook as runBeforeToolCallHookType } from "../agents/pi-tools.before-tool-call.js";

type RunBeforeToolCallHook = typeof runBeforeToolCallHookType;
type RunBeforeToolCallHookArgs = Parameters<RunBeforeToolCallHook>[0];
type RunBeforeToolCallHookResult = Awaited<ReturnType<RunBeforeToolCallHook>>;

const hookMocks = vi.hoisted(() => ({
  resolveToolLoopDetectionConfig: vi.fn(() => ({ warnAt: 3 })),
  runBeforeToolCallHook: vi.fn(
    async (args: RunBeforeToolCallHookArgs): Promise<RunBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  ),
}));

let cfg: Record<string, unknown> = {};
let lastCreateOpenClawToolsContext: Record<string, unknown> | undefined;

// Perf: keep this suite pure unit. Mock heavyweight config/session modules.
vi.mock("../config/config.js", () => ({
  loadConfig: () => cfg,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: (params?: {
    session?: { scope?: string; mainKey?: string };
    agents?: { list?: { id?: string; default?: boolean }[] };
  }) => {
    if (params?.session?.scope === "global") {
      return "global";
    }
    const agents = params?.agents?.list ?? [];
    const rawDefault = agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? "main";
    const agentId =
      String(rawDefault ?? "main")
        .trim()
        .toLowerCase() || "main";
    const mainKeyRaw = String(params?.session?.mainKey ?? "main")
      .trim()
      .toLowerCase();
    const mainKey = mainKeyRaw || "main";
    return `agent:${agentId}:${mainKey}`;
  },
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../logger.js", () => ({
  logWarn: () => {},
}));

vi.mock("../plugins/config-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/config-state.js")>();
  return {
    ...actual,
    isTestDefaultMemorySlotDisabled: () => false,
  };
});

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
}));

// Perf: the real tool factory instantiates many tools per request; for these HTTP
// Routing/policy tests we only need a small set of tool names.
vi.mock("../agents/openclaw-tools.js", () => {
  const toolInputError = (message: string) => {
    const err = new Error(message);
    err.name = "ToolInputError";
    return err;
  };
  const toolAuthorizationError = (message: string) => {
    const err = new Error(message) as Error & { status?: number };
    err.name = "ToolAuthorizationError";
    err.status = 403;
    return err;
  };

  const tools = [
    {
      execute: async () => ({ ok: true }),
      name: "session_status",
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async () => ({ ok: true, result: [] }),
      name: "agents_list",
      parameters: { properties: { action: { type: "string" } }, type: "object" },
    },
    {
      execute: async () => ({
        ok: true,
        route: {
          agentThreadId: lastCreateOpenClawToolsContext?.agentThreadId,
          agentTo: lastCreateOpenClawToolsContext?.agentTo,
        },
      }),
      name: "sessions_spawn",
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async () => ({ ok: true }),
      name: "sessions_send",
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async () => {
        throw toolInputError("invalid args");
      },
      name: "gateway",
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async () => ({ ok: true, result: "exec" }),
      name: "exec",
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async () => ({ ok: true, result: "apply_patch" }),
      name: "apply_patch",
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async () => ({ ok: true, result: "nodes" }),
      name: "nodes",
      ownerOnly: true,
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async () => ({ ok: true, result: "owner-only" }),
      name: "owner_only_test",
      ownerOnly: true,
      parameters: { properties: {}, type: "object" },
    },
    {
      execute: async (_toolCallId: string, args: unknown) => {
        const mode = (args as { mode?: unknown })?.mode;
        if (mode === "input") {
          throw toolInputError("mode invalid");
        }
        if (mode === "auth") {
          throw toolAuthorizationError("mode forbidden");
        }
        if (mode === "crash") {
          throw new Error("boom");
        }
        return { ok: true };
      },
      name: "tools_invoke_test",
      parameters: {
        additionalProperties: false,
        properties: {
          mode: { type: "string" },
        },
        required: ["mode"],
        type: "object",
      },
    },
    {
      execute: async (_toolCallId: string, args: unknown) => {
        const input = (args ?? {}) as Record<string, unknown>;
        return {
          observedFileFormat: input.fileFormat,
          observedFormat: input.format,
          ok: true,
        };
      },
      name: "diffs_compat_test",
      parameters: {
        additionalProperties: false,
        properties: {
          fileFormat: { type: "string" },
          mode: { type: "string" },
        },
        type: "object",
      },
    },
  ];

  return {
    createOpenClawTools: (ctx: Record<string, unknown>) => {
      lastCreateOpenClawToolsContext = ctx;
      return tools;
    },
  };
});

vi.mock("../agents/pi-tools.js", () => ({
  resolveToolLoopDetectionConfig: hookMocks.resolveToolLoopDetectionConfig,
}));

vi.mock("../agents/pi-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let pluginHttpHandlers: ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>)[] = [];

let sharedPort = 0;
let sharedServer: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  sharedServer = createServer((req, res) => {
    void (async () => {
      const handled = await handleToolsInvokeHttpRequest(req, res, {
        auth: { allowTailscale: false, mode: "none" },
      });
      if (handled) {
        return;
      }
      for (const handler of pluginHttpHandlers) {
        if (await handler(req, res)) {
          return;
        }
      }
      res.statusCode = 404;
      res.end("not found");
    })().catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    sharedServer?.once("error", reject);
    sharedServer?.listen(0, "127.0.0.1", () => {
      const address = sharedServer?.address() as AddressInfo | null;
      sharedPort = address?.port ?? 0;
      resolve();
    });
  });
});

afterAll(async () => {
  const server = sharedServer;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sharedServer = undefined;
});

beforeEach(() => {
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  pluginHttpHandlers = [];
  cfg = {};
  lastCreateOpenClawToolsContext = undefined;
  hookMocks.resolveToolLoopDetectionConfig.mockClear();
  hookMocks.resolveToolLoopDetectionConfig.mockImplementation(() => ({ warnAt: 3 }));
  hookMocks.runBeforeToolCallHook.mockClear();
  hookMocks.runBeforeToolCallHook.mockImplementation(
    async (args: RunBeforeToolCallHookArgs): Promise<RunBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  );
  vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true });
});

const gatewayAuthHeaders = () => ({ "x-openclaw-scopes": "operator.write" });
const gatewayAdminHeaders = () => ({ "x-openclaw-scopes": "operator.admin" });

const allowAgentsListForMain = () => {
  cfg = {
    ...cfg,
    agents: {
      list: [
        {
          default: true,
          id: "main",
          tools: {
            allow: ["agents_list"],
          },
        },
      ],
    },
  };
};

const postToolsInvoke = async (params: {
  port: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}) =>
  await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    body: JSON.stringify(params.body),
    headers: { "content-type": "application/json", ...params.headers },
    method: "POST",
  });

const withOptionalSessionKey = (body: Record<string, unknown>, sessionKey?: string) => ({
  ...body,
  ...(sessionKey ? { sessionKey } : {}),
});

const invokeAgentsList = async (params: {
  port: number;
  headers?: Record<string, string>;
  sessionKey?: string;
}) => {
  const body = withOptionalSessionKey(
    { action: "json", args: {}, tool: "agents_list" },
    params.sessionKey,
  );
  return await postToolsInvoke({ body, headers: params.headers, port: params.port });
};

const invokeTool = async (params: {
  port: number;
  tool: string;
  args?: Record<string, unknown>;
  action?: string;
  headers?: Record<string, string>;
  sessionKey?: string;
}) => {
  const body: Record<string, unknown> = withOptionalSessionKey(
    {
      args: params.args ?? {},
      tool: params.tool,
    },
    params.sessionKey,
  );
  if (params.action) {
    body.action = params.action;
  }
  return await postToolsInvoke({ body, headers: params.headers, port: params.port });
};

const invokeAgentsListAuthed = async (params: { sessionKey?: string } = {}) =>
  invokeAgentsList({
    headers: gatewayAuthHeaders(),
    port: sharedPort,
    sessionKey: params.sessionKey,
  });

const invokeToolAuthed = async (params: {
  tool: string;
  args?: Record<string, unknown>;
  action?: string;
  sessionKey?: string;
}) =>
  invokeTool({
    headers: gatewayAuthHeaders(),
    port: sharedPort,
    ...params,
  });

const expectOkInvokeResponse = async (res: Response) => {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  return body as { ok: boolean; result?: Record<string, unknown> };
};

const setMainAllowedTools = (params: {
  allow: string[];
  gatewayAllow?: string[];
  gatewayDeny?: string[];
}) => {
  cfg = {
    ...cfg,
    agents: {
      list: [{ default: true, id: "main", tools: { allow: params.allow } }],
    },
    ...(params.gatewayAllow || params.gatewayDeny
      ? {
          gateway: {
            tools: {
              ...(params.gatewayAllow ? { allow: params.gatewayAllow } : {}),
              ...(params.gatewayDeny ? { deny: params.gatewayDeny } : {}),
            },
          },
        }
      : {}),
  };
};

describe("POST /tools/invoke", () => {
  it("invokes a tool and returns {ok:true,result}", async () => {
    allowAgentsListForMain();
    const res = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("result");
    expect(lastCreateOpenClawToolsContext?.allowMediaInvokeCommands).toBe(true);
    expect(lastCreateOpenClawToolsContext?.disablePluginTools).toBe(true);
    expect(hookMocks.runBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          agentId: "main",
          loopDetection: { warnAt: 3 },
          sessionKey: "agent:main:main",
        }),
        toolName: "agents_list",
      }),
    );
  });

  it("opts direct gateway tool invocation into gateway subagent binding", async () => {
    allowAgentsListForMain();
    const res = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(res.status).toBe(200);
    expect(lastCreateOpenClawToolsContext?.allowGatewaySubagentBinding).toBe(true);
  });

  it("keeps plugin tools enabled for non-core tool invokes", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });

    const res = await invokeToolAuthed({
      args: { mode: "ok" },
      sessionKey: "main",
      tool: "tools_invoke_test",
    });

    expect(res.status).toBe(200);
    expect(lastCreateOpenClawToolsContext?.disablePluginTools).toBe(false);
  });

  it("blocks tool execution when before_tool_call rejects the invoke", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });
    hookMocks.runBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      reason: "blocked by test hook",
    });

    const res = await invokeToolAuthed({
      args: { mode: "ok" },
      sessionKey: "main",
      tool: "tools_invoke_test",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        message: "blocked by test hook",
        type: "tool_call_blocked",
      },
      ok: false,
    });
  });

  it("accepts shared-secret bearer auth on the HTTP tools surface", async () => {
    allowAgentsListForMain();
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      method: "token",
      ok: true,
    });

    const res = await postToolsInvoke({
      body: {
        action: "json",
        args: {},
        sessionKey: "main",
        tool: "agents_list",
      },
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      port: sharedPort,
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: [] });
  });

  it("uses before_tool_call adjusted params for HTTP tool execution", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });
    hookMocks.runBeforeToolCallHook.mockImplementationOnce(async () => ({
      blocked: false,
      params: { mode: "rewritten" },
    }));

    const res = await invokeToolAuthed({
      args: { mode: "input" },
      sessionKey: "main",
      tool: "tools_invoke_test",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toMatchObject({ ok: true });
  });

  it("supports tools.alsoAllow in profile and implicit modes", async () => {
    cfg = {
      ...cfg,
      agents: { list: [{ default: true, id: "main" }] },
      tools: { alsoAllow: ["agents_list"], profile: "minimal" },
    };

    const resProfile = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(resProfile.status).toBe(200);
    const profileBody = await resProfile.json();
    expect(profileBody.ok).toBe(true);

    cfg = {
      ...cfg,
      tools: { alsoAllow: ["agents_list"] },
    };

    const resImplicit = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(resImplicit.status).toBe(200);
    const implicitBody = await resImplicit.json();
    expect(implicitBody.ok).toBe(true);
  });

  it("routes tools invoke before plugin HTTP handlers", async () => {
    const pluginHandler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 418;
      res.end("plugin");
      return true;
    });
    allowAgentsListForMain();
    pluginHttpHandlers = [async (req, res) => pluginHandler(req, res)];

    const res = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(res.status).toBe(200);
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("returns 404 when denylisted or blocked by tools.profile", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [
          {
            default: true,
            id: "main",
            tools: {
              deny: ["agents_list"],
            },
          },
        ],
      },
    };
    const denyRes = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(denyRes.status).toBe(404);

    allowAgentsListForMain();
    cfg = {
      ...cfg,
      tools: { profile: "minimal" },
    };

    const profileRes = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(profileRes.status).toBe(404);
  });

  it("denies sessions_spawn via HTTP even when agent policy allows", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [
          {
            default: true,
            id: "main",
            tools: { allow: ["sessions_spawn"] },
          },
        ],
      },
    };

    const res = await invokeToolAuthed({
      args: { task: "test" },
      sessionKey: "main",
      tool: "sessions_spawn",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.type).toBe("not_found");
  });

  it("propagates message target/thread headers into tools context for sessions_spawn", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [{ default: true, id: "main", tools: { allow: ["sessions_spawn"] } }],
      },
      gateway: { tools: { allow: ["sessions_spawn"] } },
    };

    const res = await invokeTool({
      headers: {
        ...gatewayAuthHeaders(),
        "x-openclaw-message-to": "channel:24514",
        "x-openclaw-thread-id": "thread-24514",
      },
      port: sharedPort,
      sessionKey: "main",
      tool: "sessions_spawn",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result?.route).toEqual({
      agentThreadId: "thread-24514",
      agentTo: "channel:24514",
    });
  });

  it("denies sessions_send via HTTP gateway", async () => {
    setMainAllowedTools({ allow: ["sessions_send"] });

    const res = await invokeToolAuthed({
      sessionKey: "main",
      tool: "sessions_send",
    });

    expect(res.status).toBe(404);
  });

  it("denies gateway tool via HTTP", async () => {
    setMainAllowedTools({ allow: ["gateway"] });

    const res = await invokeToolAuthed({
      sessionKey: "main",
      tool: "gateway",
    });

    expect(res.status).toBe(404);
  });

  it("allows gateway tool via HTTP when explicitly enabled in gateway.tools.allow", async () => {
    setMainAllowedTools({ allow: ["gateway"], gatewayAllow: ["gateway"] });

    const res = await invokeTool({
      headers: gatewayAdminHeaders(),
      port: sharedPort,
      sessionKey: "main",
      tool: "gateway",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error?.type).toBe("tool_error");
  });

  it("treats gateway.tools.deny as higher priority than gateway.tools.allow", async () => {
    setMainAllowedTools({
      allow: ["gateway"],
      gatewayAllow: ["gateway"],
      gatewayDeny: ["gateway"],
    });

    const res = await invokeToolAuthed({
      sessionKey: "main",
      tool: "gateway",
    });

    expect(res.status).toBe(404);
  });

  it("uses the configured main session key when sessionKey is missing or main", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [
          {
            id: "main",
            tools: {
              deny: ["agents_list"],
            },
          },
          {
            default: true,
            id: "ops",
            tools: {
              allow: ["agents_list"],
            },
          },
        ],
      },
      session: { mainKey: "primary" },
    };

    const resDefault = await invokeAgentsListAuthed();
    expect(resDefault.status).toBe(200);

    const resMain = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(resMain.status).toBe(200);
  });

  it("maps tool input/auth errors to 400/403 and unexpected execution errors to 500", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [{ default: true, id: "main", tools: { allow: ["tools_invoke_test"] } }],
      },
    };

    const inputRes = await invokeToolAuthed({
      args: { mode: "input" },
      sessionKey: "main",
      tool: "tools_invoke_test",
    });
    expect(inputRes.status).toBe(400);
    const inputBody = await inputRes.json();
    expect(inputBody.ok).toBe(false);
    expect(inputBody.error?.type).toBe("tool_error");
    expect(inputBody.error?.message).toBe("mode invalid");

    const authRes = await invokeToolAuthed({
      args: { mode: "auth" },
      sessionKey: "main",
      tool: "tools_invoke_test",
    });
    expect(authRes.status).toBe(403);
    const authBody = await authRes.json();
    expect(authBody.ok).toBe(false);
    expect(authBody.error?.type).toBe("tool_error");
    expect(authBody.error?.message).toBe("mode forbidden");

    const crashRes = await invokeToolAuthed({
      args: { mode: "crash" },
      sessionKey: "main",
      tool: "tools_invoke_test",
    });
    expect(crashRes.status).toBe(500);
    const crashBody = await crashRes.json();
    expect(crashBody.ok).toBe(false);
    expect(crashBody.error?.type).toBe("tool_error");
    expect(crashBody.error?.message).toBe("tool execution failed");
  });

  it("passes deprecated format alias through invoke payloads even when schema omits it", async () => {
    setMainAllowedTools({ allow: ["diffs_compat_test"] });

    const res = await invokeToolAuthed({
      args: { format: "pdf", mode: "file" },
      sessionKey: "main",
      tool: "diffs_compat_test",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result?.observedFormat).toBe("pdf");
    expect(body.result?.observedFileFormat).toBeUndefined();
  });

  it("requires operator.write scope for HTTP tool invocation", async () => {
    allowAgentsListForMain();
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      method: "trusted-proxy",
      ok: true,
    });

    const res = await invokeTool({
      headers: {
        "x-openclaw-scopes": "",
      },
      port: sharedPort,
      sessionKey: "main",
      tool: "agents_list",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        message: "missing scope: operator.write",
        type: "forbidden",
      },
      ok: false,
    });
  });

  it("treats shared-secret bearer auth as full operator access on /tools/invoke", async () => {
    allowAgentsListForMain();
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      method: "token",
      ok: true,
    });

    const res = await postToolsInvoke({
      body: {
        action: "json",
        args: {},
        sessionKey: "main",
        tool: "agents_list",
      },
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      port: sharedPort,
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: [] });
  });

  it("applies owner-only tool policy on the HTTP path", async () => {
    setMainAllowedTools({ allow: ["owner_only_test"] });

    const deniedRes = await invokeToolAuthed({
      sessionKey: "main",
      tool: "owner_only_test",
    });
    expect(deniedRes.status).toBe(404);

    const allowedRes = await invokeTool({
      headers: gatewayAdminHeaders(),
      port: sharedPort,
      sessionKey: "main",
      tool: "owner_only_test",
    });
    const allowedBody = await expectOkInvokeResponse(allowedRes);
    expect(allowedBody.result).toEqual({ ok: true, result: "owner-only" });
  });

  it("treats shared-secret bearer auth as owner on /tools/invoke", async () => {
    setMainAllowedTools({ allow: ["owner_only_test"] });
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      method: "token",
      ok: true,
    });

    const res = await invokeTool({
      headers: {
        authorization: "Bearer secret",
        "x-openclaw-scopes": "operator.approvals",
      },
      port: sharedPort,
      sessionKey: "main",
      tool: "owner_only_test",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: "owner-only" });
  });

  it("extends the HTTP deny list to high-risk execution and file tools", async () => {
    setMainAllowedTools({ allow: ["exec", "apply_patch", "nodes"] });

    const execRes = await invokeToolAuthed({
      sessionKey: "main",
      tool: "exec",
    });
    const patchRes = await invokeToolAuthed({
      sessionKey: "main",
      tool: "apply_patch",
    });
    const nodesRes = await invokeToolAuthed({
      sessionKey: "main",
      tool: "nodes",
    });
    const nodesAdminRes = await invokeTool({
      headers: gatewayAdminHeaders(),
      port: sharedPort,
      sessionKey: "main",
      tool: "nodes",
    });

    expect(execRes.status).toBe(404);
    expect(patchRes.status).toBe(404);
    expect(nodesRes.status).toBe(404);
    expect(nodesAdminRes.status).toBe(404);
  });
});
