import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("openclaw plugin tool context", () => {
  it("forwards trusted requester sender identity", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        requesterSenderId: "trusted-sender",
        senderIsOwner: true,
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        requesterSenderId: "trusted-sender",
        senderIsOwner: true,
      }),
    );
  });

  it("forwards fs policy for plugin tool sandbox enforcement", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        fsPolicy: { workspaceOnly: true },
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        fsPolicy: { workspaceOnly: true },
      }),
    );
  });

  it("forwards ephemeral sessionId", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        agentSessionKey: "agent:main:telegram:direct:12345",
        config: {} as never,
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        sessionKey: "agent:main:telegram:direct:12345",
      }),
    );
  });

  it("infers the default agent workspace when workspaceDir is omitted", () => {
    const workspaceDir = path.join(process.cwd(), "tmp-main-workspace");
    const result = resolveOpenClawPluginToolInputs({
      options: {
        agentSessionKey: "main",
        config: {
          agents: {
            defaults: { workspace: workspaceDir },
            list: [{ default: true, id: "main" }],
          },
        } as never,
      },
      resolvedConfig: {
        agents: {
          defaults: { workspace: workspaceDir },
          list: [{ default: true, id: "main" }],
        },
      } as never,
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        agentId: "main",
        workspaceDir,
      }),
    );
  });

  it("infers the session agent workspace when workspaceDir is omitted", () => {
    const supportWorkspace = path.join(process.cwd(), "tmp-support-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { default: true, id: "main" },
          { id: "support", workspace: supportWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        agentSessionKey: "agent:support:main",
        config,
      },
      resolvedConfig: config,
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        agentId: "support",
        workspaceDir: supportWorkspace,
      }),
    );
  });

  it("forwards browser session wiring", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        allowHostBrowserControl: true,
        config: {} as never,
        sandboxBrowserBridgeUrl: "http://127.0.0.1:9999",
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        browser: {
          allowHostControl: true,
          sandboxBridgeUrl: "http://127.0.0.1:9999",
        },
      }),
    );
  });

  it("forwards gateway subagent binding", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        allowGatewaySubagentBinding: true,
        config: {} as never,
      },
    });

    expect(result.allowGatewaySubagentBinding).toBe(true);
  });

  it("forwards ambient deliveryContext", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        agentAccountId: "work",
        agentChannel: "slack",
        agentThreadId: "1710000000.000100",
        agentTo: "channel:C123",
        config: {} as never,
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        deliveryContext: {
          accountId: "work",
          channel: "slack",
          threadId: "1710000000.000100",
          to: "channel:C123",
        },
      }),
    );
  });

  it("does not inject ambient thread defaults into plugin tools", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ text: "ok", type: "text" as const }],
      details: {},
    }));
    const sharedTool: AnyAgentTool = {
      description: "test",
      execute: executeMock,
      label: "plugin-thread-default",
      name: "plugin-thread-default",
      parameters: {
        properties: {
          threadId: { type: "string" },
        },
        type: "object",
      },
    };

    const [first] = applyPluginToolDeliveryDefaults({
      deliveryContext: { threadId: "111.222" },
      tools: [sharedTool],
    });
    const [second] = applyPluginToolDeliveryDefaults({
      deliveryContext: { threadId: "333.444" },
      tools: [sharedTool],
    });

    expect(first).toBe(sharedTool);
    expect(second).toBe(sharedTool);

    await first?.execute("call-1", {});
    await second?.execute("call-2", {});

    expect(executeMock).toHaveBeenNthCalledWith(1, "call-1", {});
    expect(executeMock).toHaveBeenNthCalledWith(2, "call-2", {});
  });

  it("does not inject messageThreadId defaults for missing params objects", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ text: "ok", type: "text" as const }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      description: "test",
      execute: executeMock,
      label: "plugin-message-thread-default",
      name: "plugin-message-thread-default",
      parameters: {
        properties: {
          messageThreadId: { type: "number" },
        },
        type: "object",
      },
    };

    const [wrapped] = applyPluginToolDeliveryDefaults({
      deliveryContext: { threadId: "77" },
      tools: [tool],
    });

    await wrapped?.execute("call-1", undefined);

    expect(executeMock).toHaveBeenCalledWith("call-1", undefined);
  });

  it("does not infer string thread ids for tools that declare thread parameters", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ text: "ok", type: "text" as const }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      description: "test",
      execute: executeMock,
      label: "plugin-string-thread-default",
      name: "plugin-string-thread-default",
      parameters: {
        properties: {
          threadId: { type: "string" },
        },
        type: "object",
      },
    };

    const [wrapped] = applyPluginToolDeliveryDefaults({
      deliveryContext: { threadId: "77" },
      tools: [tool],
    });

    await wrapped?.execute("call-1", {});

    expect(executeMock).toHaveBeenCalledWith("call-1", {});
  });

  it("preserves explicit thread params when ambient defaults exist", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ text: "ok", type: "text" as const }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      description: "test",
      execute: executeMock,
      label: "plugin-thread-override",
      name: "plugin-thread-override",
      parameters: {
        properties: {
          threadId: { type: "string" },
        },
        type: "object",
      },
    };

    const [wrapped] = applyPluginToolDeliveryDefaults({
      deliveryContext: { threadId: "111.222" },
      tools: [tool],
    });

    await wrapped?.execute("call-1", { threadId: "explicit" });

    expect(executeMock).toHaveBeenCalledWith("call-1", { threadId: "explicit" });
  });
});
