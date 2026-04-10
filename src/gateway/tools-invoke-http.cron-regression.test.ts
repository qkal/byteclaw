import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";
const resolveToolLoopDetectionConfig = () => ({ warnAt: 3 });
const runBeforeToolCallHook = async (args: { params: unknown }) => ({
  blocked: false as const,
  params: args.params,
});

let cfg: Record<string, unknown> = {};
const alwaysAuthorized = async () => ({ ok: true as const });
const disableDefaultMemorySlot = () => false;
const noPluginToolMeta = () => undefined;
const noWarnLog = () => {};

vi.mock("../config/config.js", () => ({
  loadConfig: () => cfg,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: alwaysAuthorized,
}));

vi.mock("../logger.js", () => ({
  logWarn: noWarnLog,
}));

vi.mock("../agents/pi-tools.js", () => ({
  resolveToolLoopDetectionConfig,
}));

vi.mock("../agents/pi-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook,
}));

vi.mock("../plugins/config-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/config-state.js")>();
  return {
    ...actual,
    isTestDefaultMemorySlotDisabled: disableDefaultMemorySlot,
  };
});

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: noPluginToolMeta,
}));

vi.mock("../agents/openclaw-tools.js", () => {
  const tools = [
    {
      execute: async () => ({ ok: true, via: "cron" }),
      name: "cron",
      parameters: { properties: { action: { type: "string" } }, type: "object" },
    },
    {
      execute: async () => ({ ok: true, via: "gateway" }),
      name: "gateway",
      parameters: { properties: { action: { type: "string" } }, type: "object" },
    },
  ];
  return {
    createOpenClawTools: () => tools,
  };
});

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleToolsInvokeHttpRequest(req, res, {
      auth: { allowTailscale: false, mode: "token", token: TEST_GATEWAY_TOKEN },
    }).then((handled) => {
      if (handled) {
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      port = address?.port ?? 0;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

beforeEach(() => {
  cfg = {};
});

async function invoke(tool: string, scopes = "operator.write") {
  return await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    body: JSON.stringify({ action: "status", args: {}, sessionKey: "main", tool }),
    headers: {
      authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
      "content-type": "application/json",
      "x-openclaw-scopes": scopes,
    },
    method: "POST",
  });
}

describe("tools invoke HTTP denylist", () => {
  it("blocks cron and gateway by default", async () => {
    const gatewayRes = await invoke("gateway");
    const cronRes = await invoke("cron", "operator.admin");

    expect(gatewayRes.status).toBe(404);
    expect(cronRes.status).toBe(404);
  });

  it("allows cron once gateway.tools.allow explicitly removes the default deny", async () => {
    cfg = {
      gateway: {
        tools: {
          allow: ["cron"],
        },
      },
    };

    const cronRes = await invoke("cron", "operator.admin");

    expect(cronRes.status).toBe(200);
  });

  it("keeps gateway denied under the coding profile while honoring explicit cron allow", async () => {
    cfg = {
      gateway: {
        tools: {
          allow: ["cron"],
        },
      },
      tools: {
        profile: "coding",
      },
    };

    const cronRes = await invoke("cron", "operator.admin");
    const gatewayRes = await invoke("gateway");

    expect(cronRes.status).toBe(200);
    expect(gatewayRes.status).toBe(404);
  });
});
