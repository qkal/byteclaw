import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../../../test/helpers/plugins/mock-http-response.js";
import { createRuntimeTaskFlow } from "../../../test/helpers/plugins/runtime-taskflow.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { type TaskFlowWebhookTarget, createTaskFlowWebhookRequestHandler } from "./http.js";

const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    cancelSessionMock,
    killSubagentRunAdminMock,
    sendMessageMock,
  };
});

vi.mock("../../../src/tasks/task-registry-delivery-runtime.js", () => ({
  sendMessage: hoisted.sendMessageMock,
}));

vi.mock("../../../src/acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../../../src/agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  socket: { remoteAddress: string };
};

let nextSessionId = 0;

function createJsonRequest(params: {
  path: string;
  secret?: string;
  body: unknown;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = "POST";
  req.url = params.path;
  req.headers = {
    "content-type": "application/json",
    ...(params.secret ? { "x-openclaw-webhook-secret": params.secret } : {}),
  };
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  void Promise.resolve().then(() => {
    req.emit("data", Buffer.from(JSON.stringify(params.body), "utf8"));
    req.emit("end");
  });

  return req;
}

function createHandler(): {
  handler: ReturnType<typeof createTaskFlowWebhookRequestHandler>;
  target: TaskFlowWebhookTarget;
} {
  const runtime = createRuntimeTaskFlow();
  nextSessionId += 1;
  const target: TaskFlowWebhookTarget = {
    defaultControllerId: "webhooks/zapier",
    path: "/plugins/webhooks/zapier",
    routeId: "zapier",
    secret: "shared-secret",
    taskFlow: runtime.bindSession({
      sessionKey: `agent:main:webhook-test-${String(nextSessionId)}`,
    }),
  };
  const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>([[target.path, [target]]]);
  return {
    handler: createTaskFlowWebhookRequestHandler({
      cfg: {} as OpenClawConfig,
      targetsByPath,
    }),
    target,
  };
}

async function dispatchJsonRequest(params: {
  handler: ReturnType<typeof createTaskFlowWebhookRequestHandler>;
  path: string;
  secret?: string;
  body: unknown;
}) {
  const req = createJsonRequest({
    body: params.body,
    path: params.path,
    secret: params.secret,
  });
  const res = createMockServerResponse();
  await params.handler(req, res);
  return res;
}

function parseJsonBody(res: { body?: string | Buffer | null }) {
  return JSON.parse(String(res.body ?? ""));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createTaskFlowWebhookRequestHandler", () => {
  it("rejects requests with the wrong secret", async () => {
    const { handler, target } = createHandler();
    const res = await dispatchJsonRequest({
      body: {
        action: "list_flows",
      },
      handler,
      path: target.path,
      secret: "wrong-secret",
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
    expect(target.taskFlow.list()).toEqual([]);
  });

  it("creates flows through the bound session and scrubs owner metadata from responses", async () => {
    const { handler, target } = createHandler();
    const res = await dispatchJsonRequest({
      body: {
        action: "create_flow",
        goal: "Review inbound queue",
      },
      handler,
      path: target.path,
      secret: target.secret,
    });

    expect(res.statusCode).toBe(200);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.flow).toMatchObject({
      controllerId: "webhooks/zapier",
      goal: "Review inbound queue",
      syncMode: "managed",
    });
    expect(parsed.result.flow.ownerKey).toBeUndefined();
    expect(parsed.result.flow.requesterOrigin).toBeUndefined();
    expect(target.taskFlow.get(parsed.result.flow.flowId)?.flowId).toBe(parsed.result.flow.flowId);
  });

  it("runs child tasks and scrubs task ownership fields from responses", async () => {
    const { handler, target } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Triage inbox",
    });
    const res = await dispatchJsonRequest({
      body: {
        action: "run_task",
        childSessionKey: "agent:main:subagent:child",
        flowId: flow.flowId,
        lastEventAt: 10,
        runtime: "acp",
        startedAt: 10,
        status: "running",
        task: "Inspect the next message batch",
      },
      handler,
      path: target.path,
      secret: target.secret,
    });

    expect(res.statusCode).toBe(200);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.created).toBe(true);
    expect(parsed.result.task).toMatchObject({
      childSessionKey: "agent:main:subagent:child",
      parentFlowId: flow.flowId,
      runtime: "acp",
    });
    expect(parsed.result.task.ownerKey).toBeUndefined();
    expect(parsed.result.task.requesterSessionKey).toBeUndefined();
  });

  it("returns 404 for missing flow mutations", async () => {
    const { handler, target } = createHandler();
    const res = await dispatchJsonRequest({
      body: {
        action: "set_waiting",
        expectedRevision: 0,
        flowId: "flow-missing",
      },
      handler,
      path: target.path,
      secret: target.secret,
    });

    expect(res.statusCode).toBe(404);
    const parsed = parseJsonBody(res);
    expect(parsed).toMatchObject({
      code: "not_found",
      error: "TaskFlow not found.",
      ok: false,
      result: {
        applied: false,
        code: "not_found",
      },
    });
  });

  it("returns 409 for revision conflicts", async () => {
    const { handler, target } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });
    const res = await dispatchJsonRequest({
      body: {
        action: "set_waiting",
        expectedRevision: flow.revision + 1,
        flowId: flow.flowId,
      },
      handler,
      path: target.path,
      secret: target.secret,
    });

    expect(res.statusCode).toBe(409);
    const parsed = parseJsonBody(res);
    expect(parsed).toMatchObject({
      code: "revision_conflict",
      ok: false,
      result: {
        applied: false,
        code: "revision_conflict",
        current: {
          flowId: flow.flowId,
          revision: flow.revision,
        },
      },
    });
  });

  it("rejects internal runtimes and running-only metadata from external callers", async () => {
    const { handler, target } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });

    const runtimeRes = await dispatchJsonRequest({
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "cli",
        task: "Inspect queue",
      },
      handler,
      path: target.path,
      secret: target.secret,
    });
    expect(runtimeRes.statusCode).toBe(400);
    expect(parseJsonBody(runtimeRes)).toMatchObject({
      code: "invalid_request",
      ok: false,
    });

    const queuedMetadataRes = await dispatchJsonRequest({
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        startedAt: 10,
        task: "Inspect queue",
      },
      handler,
      path: target.path,
      secret: target.secret,
    });
    expect(queuedMetadataRes.statusCode).toBe(400);
    expect(parseJsonBody(queuedMetadataRes)).toMatchObject({
      code: "invalid_request",
      error:
        "status: status must be running when startedAt, lastEventAt, or progressSummary is provided",
      ok: false,
    });
  });

  it("reuses the same task record when retried with the same runId", async () => {
    const { handler, target } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Triage inbox",
    });

    const first = await dispatchJsonRequest({
      body: {
        action: "run_task",
        childSessionKey: "agent:main:subagent:child",
        flowId: flow.flowId,
        runId: "retry-me",
        runtime: "acp",
        task: "Inspect the next message batch",
      },
      handler,
      path: target.path,
      secret: target.secret,
    });
    const second = await dispatchJsonRequest({
      body: {
        action: "run_task",
        childSessionKey: "agent:main:subagent:child",
        flowId: flow.flowId,
        runId: "retry-me",
        runtime: "acp",
        task: "Inspect the next message batch",
      },
      handler,
      path: target.path,
      secret: target.secret,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstParsed = parseJsonBody(first);
    const secondParsed = parseJsonBody(second);
    expect(firstParsed.result.task.taskId).toBe(secondParsed.result.task.taskId);
    expect(target.taskFlow.getTaskSummary(flow.flowId)?.total).toBe(1);
  });

  it("returns 409 when cancellation targets a terminal flow", async () => {
    const { handler, target } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });
    const finished = target.taskFlow.finish({
      expectedRevision: flow.revision,
      flowId: flow.flowId,
    });
    expect(finished.applied).toBe(true);

    const res = await dispatchJsonRequest({
      body: {
        action: "cancel_flow",
        flowId: flow.flowId,
      },
      handler,
      path: target.path,
      secret: target.secret,
    });

    expect(res.statusCode).toBe(409);
    expect(parseJsonBody(res)).toMatchObject({
      code: "terminal",
      error: "Flow is already succeeded.",
      ok: false,
      result: {
        cancelled: false,
        found: true,
        reason: "Flow is already succeeded.",
      },
    });
  });
});
