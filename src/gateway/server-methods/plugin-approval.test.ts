import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createManager() {
  return new ExecApprovalManager<PluginApprovalRequestPayload>();
}

function createMockOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    client: {
      connect: {
        client: { displayName: "Test Client", id: "test-client" },
      },
    },
    context: {
      broadcast: vi.fn(),
      hasExecApprovalClients: () => true,
      logGateway: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    },
    isWebchatConnect: () => false,
    params,
    req: { id: "req-1", method, params },
    respond: vi.fn(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("createPluginApprovalHandlers", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns handlers for all three plugin approval methods", () => {
    const handlers = createPluginApprovalHandlers(manager);
    expect(handlers).toHaveProperty("plugin.approval.request");
    expect(handlers).toHaveProperty("plugin.approval.waitDecision");
    expect(handlers).toHaveProperty("plugin.approval.resolve");
    expect(typeof handlers["plugin.approval.request"]).toBe("function");
    expect(typeof handlers["plugin.approval.waitDecision"]).toBe("function");
    expect(typeof handlers["plugin.approval.resolve"]).toBe("function");
  });

  describe("plugin.approval.request", () => {
    it("rejects invalid params", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {});
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: expect.any(String),
        }),
      );
    });

    it("creates and registers approval with twoPhase", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          description: "This tool modifies production data",
          severity: "warning",
          title: "Sensitive action",
          twoPhase: true,
        },
        { respond },
      );

      // Don't await — the handler blocks waiting for the decision.
      // Instead, let it run and resolve the approval after the accepted response.
      const handlerPromise = handlers["plugin.approval.request"](opts);

      // Wait for the twoPhase "accepted" response
      await vi.waitFor(() => {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ id: expect.any(String), status: "accepted" }),
          undefined,
        );
      });

      expect(opts.context.broadcast).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id: expect.any(String) }),
        { dropIfSlow: true },
      );

      // Resolve the approval so the handler can complete
      const acceptedCall = respond.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === "accepted",
      );
      const approvalId = (acceptedCall?.[1] as Record<string, unknown>)?.id as string;
      manager.resolve(approvalId, "allow-once");

      await handlerPromise;

      // Final response with decision
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ decision: "allow-once", id: approvalId }),
        undefined,
      );
    });

    it("expires immediately when no approval route", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions(
        "plugin.approval.request",
        {
          description: "Desc",
          title: "Sensitive action",
        },
        {
          context: {
            broadcast: vi.fn(),
            hasExecApprovalClients: () => false,
            logGateway: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      );
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ decision: null }),
        undefined,
      );
    });

    it("passes caller connId to hasExecApprovalClients to exclude self", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const hasExecApprovalClients = vi.fn().mockReturnValue(false);
      const opts = createMockOptions(
        "plugin.approval.request",
        { description: "D", title: "T" },
        {
          client: {
            connId: "backend-conn-42",
            connect: { client: { displayName: "Test", id: "test" } },
          } as unknown as GatewayRequestHandlerOptions["client"],
          context: {
            broadcast: vi.fn(),
            hasExecApprovalClients,
            logGateway: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      );
      await handlers["plugin.approval.request"](opts);
      expect(hasExecApprovalClients).toHaveBeenCalledWith("backend-conn-42");
    });

    it("keeps plugin approvals pending when the originating chat can handle /approve directly", async () => {
      vi.useFakeTimers();
      try {
        const handlers = createPluginApprovalHandlers(manager);
        const respond = vi.fn();
        const opts = createMockOptions(
          "plugin.approval.request",
          {
            description: "Desc",
            title: "Sensitive action",
            turnSourceChannel: "slack",
            turnSourceTo: "C123",
            twoPhase: true,
          },
          {
            context: {
              broadcast: vi.fn(),
              hasExecApprovalClients: () => false,
              logGateway: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
            } as unknown as GatewayRequestHandlerOptions["context"],
            respond,
          },
        );

        const requestPromise = handlers["plugin.approval.request"](opts);

        await vi.waitFor(() => {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ id: expect.any(String), status: "accepted" }),
            undefined,
          );
        });

        const acceptedCall = respond.mock.calls.find(
          (call) => (call[1] as Record<string, unknown>)?.status === "accepted",
        );
        const approvalId = (acceptedCall?.[1] as Record<string, unknown>)?.id as string;
        manager.resolve(approvalId, "allow-once");

        await requestPromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects invalid severity value", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        description: "D",
        severity: "extreme",
        title: "T",
      });
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
    });

    it("rejects title exceeding max length", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        description: "D",
        title: "x".repeat(81),
      });
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
    });

    it("rejects description exceeding max length", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        description: "x".repeat(257),
        title: "T",
      });
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
    });

    it("rejects timeoutMs exceeding max", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        description: "D",
        timeoutMs: 700_000,
        title: "T",
      });
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
    });

    it("generates plugin-prefixed IDs", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const opts = createMockOptions(
        "plugin.approval.request",
        { description: "D", title: "T" },
        {
          context: {
            broadcast: vi.fn(),
            hasExecApprovalClients: () => false,
            logGateway: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
          } as unknown as GatewayRequestHandlerOptions["context"],
          respond,
        },
      );
      await handlers["plugin.approval.request"](opts);
      const result = respond.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(result?.id).toEqual(expect.stringMatching(/^plugin:/));
    });

    it("passes plugin-prefixed IDs directly to manager.create", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const createSpy = vi.spyOn(manager, "create");
      const opts = createMockOptions(
        "plugin.approval.request",
        { description: "D", title: "T" },
        {
          context: {
            broadcast: vi.fn(),
            hasExecApprovalClients: () => false,
            logGateway: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      );

      await handlers["plugin.approval.request"](opts);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0]?.[2]).toEqual(expect.stringMatching(/^plugin:/));
    });

    it("rejects plugin-provided id field", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.request", {
        description: "D",
        id: "plugin-provided-id",
        title: "T",
      });
      await handlers["plugin.approval.request"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("unexpected property") }),
      );
    });
  });

  describe("plugin.approval.list", () => {
    it("lists pending plugin approvals", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const respond = vi.fn();
      const requestOpts = createMockOptions(
        "plugin.approval.request",
        {
          description: "Desc",
          title: "Sensitive action",
          twoPhase: true,
        },
        { respond },
      );

      const handlerPromise = handlers["plugin.approval.request"](requestOpts);
      await vi.waitFor(() => {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ id: expect.any(String), status: "accepted" }),
          undefined,
        );
      });

      const listRespond = vi.fn();
      await handlers["plugin.approval.list"](
        createMockOptions("plugin.approval.list", {}, { respond: listRespond }),
      );
      expect(listRespond).toHaveBeenCalledWith(
        true,
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(/^plugin:/),
            request: expect.objectContaining({
              description: "Desc",
              title: "Sensitive action",
            }),
          }),
        ]),
        undefined,
      );

      const acceptedCall = respond.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === "accepted",
      );
      const approvalId = (acceptedCall?.[1] as Record<string, unknown>)?.id as string;
      manager.resolve(approvalId, "allow-once");
      await handlerPromise;
    });
  });

  describe("plugin.approval.waitDecision", () => {
    it("rejects missing id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", {});
      await handlers["plugin.approval.waitDecision"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("id is required") }),
      );
    });

    it("returns not found for unknown id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.waitDecision", { id: "unknown" });
      await handlers["plugin.approval.waitDecision"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("expired or not found") }),
      );
    });

    it("returns decision when resolved", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ description: "D", title: "T" }, 60_000);
      void manager.register(record, 60_000);

      // Resolve before waiting
      manager.resolve(record.id, "allow-once");

      const opts = createMockOptions("plugin.approval.waitDecision", { id: record.id });
      await handlers["plugin.approval.waitDecision"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ decision: "allow-once", id: record.id }),
        undefined,
      );
    });
  });

  describe("plugin.approval.resolve", () => {
    it("rejects invalid params", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.resolve", {});
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: expect.any(String),
        }),
      );
    });

    it("rejects invalid decision", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ description: "D", title: "T" }, 60_000);
      void manager.register(record, 60_000);
      const opts = createMockOptions("plugin.approval.resolve", {
        decision: "invalid",
        id: record.id,
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "invalid decision" }),
      );
    });

    it("resolves a pending approval", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ description: "D", title: "T" }, 60_000);
      void manager.register(record, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        decision: "deny",
        id: record.id,
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(opts.context.broadcast).toHaveBeenCalledWith(
        "plugin.approval.resolved",
        expect.objectContaining({ decision: "deny", id: record.id }),
        { dropIfSlow: true },
      );
    });

    it("rejects unknown approval id", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const opts = createMockOptions("plugin.approval.resolve", {
        decision: "allow-once",
        id: "nonexistent",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          details: expect.objectContaining({ reason: "APPROVAL_NOT_FOUND" }),
          message: expect.stringContaining("unknown or expired"),
        }),
      );
    });

    it("accepts unique short id prefixes", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const record = manager.create({ description: "D", title: "T" }, 60_000, "abcdef-1234");
      void manager.register(record, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        decision: "allow-always",
        id: "abcdef",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(manager.getSnapshot(record.id)?.decision).toBe("allow-always");
    });

    it("does not leak candidate ids when prefixes are ambiguous", async () => {
      const handlers = createPluginApprovalHandlers(manager);
      const recordA = manager.create({ description: "D", title: "A" }, 60_000, "plugin:abc-1111");
      const recordB = manager.create({ description: "D", title: "B" }, 60_000, "plugin:abc-2222");
      void manager.register(recordA, 60_000);
      void manager.register(recordB, 60_000);

      const opts = createMockOptions("plugin.approval.resolve", {
        decision: "deny",
        id: "plugin:abc",
      });
      await handlers["plugin.approval.resolve"](opts);
      expect(opts.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "unknown or expired approval id",
        }),
      );
    });
  });
});
