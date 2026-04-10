import { describe, expect, it } from "vitest";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { chatHandlers } from "./chat.js";

async function invokeSingleRunAbort({
  context,
  runId = "run-1",
  connId,
  deviceId,
  scopes,
}: {
  context: ReturnType<typeof createChatAbortContext>;
  runId?: string;
  connId: string;
  deviceId: string;
  scopes: string[];
}) {
  return await invokeChatAbortHandler({
    client: {
      connId,
      connect: { device: { id: deviceId }, scopes },
    },
    context,
    handler: chatHandlers["chat.abort"],
    request: { runId, sessionKey: "main" },
  });
}

function createSingleAbortContext() {
  return createChatAbortContext({
    chatAbortControllers: new Map([
      [
        "run-1",
        createActiveRun("main", { owner: { connId: "conn-owner", deviceId: "dev-owner" } }),
      ],
    ]),
  });
}

describe("chat.abort authorization", () => {
  it("rejects explicit run aborts from other clients", async () => {
    const context = createSingleAbortContext();

    const respond = await invokeSingleRunAbort({
      connId: "conn-other",
      context,
      deviceId: "dev-other",
      scopes: ["operator.write"],
    });

    const [ok, payload, error] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "unauthorized" });
    expect(context.chatAbortControllers.has("run-1")).toBe(true);
  });

  it("allows the same paired device to abort after reconnecting", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-1", createActiveRun("main", { owner: { connId: "conn-old", deviceId: "dev-1" } })],
      ]),
    });

    const respond = await invokeChatAbortHandler({
      client: {
        connId: "conn-new",
        connect: { device: { id: "dev-1" }, scopes: ["operator.write"] },
      },
      context,
      handler: chatHandlers["chat.abort"],
      request: { runId: "run-1", sessionKey: "main" },
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-1"] });
    expect(context.chatAbortControllers.has("run-1")).toBe(false);
  });

  it("only aborts session-scoped runs owned by the requester", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-mine", createActiveRun("main", { owner: { deviceId: "dev-1" } })],
        ["run-other", createActiveRun("main", { owner: { deviceId: "dev-2" } })],
      ]),
    });

    const respond = await invokeChatAbortHandler({
      client: {
        connId: "conn-1",
        connect: { device: { id: "dev-1" }, scopes: ["operator.write"] },
      },
      context,
      handler: chatHandlers["chat.abort"],
      request: { sessionKey: "main" },
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-mine"] });
    expect(context.chatAbortControllers.has("run-mine")).toBe(false);
    expect(context.chatAbortControllers.has("run-other")).toBe(true);
  });

  it("allows operator.admin clients to bypass owner checks", async () => {
    const context = createSingleAbortContext();

    const respond = await invokeSingleRunAbort({
      connId: "conn-admin",
      context,
      deviceId: "dev-admin",
      scopes: ["operator.admin"],
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-1"] });
  });
});
