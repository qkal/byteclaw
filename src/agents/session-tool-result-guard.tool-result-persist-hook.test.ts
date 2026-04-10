import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const EMPTY_PLUGIN_SCHEMA = { additionalProperties: false, properties: {}, type: "object" };
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function writeTempPlugin(params: { dir: string; id: string; body: string }): string {
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        configSchema: EMPTY_PLUGIN_SCHEMA,
        id: params.id,
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

function appendToolCallAndResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
  appendMessage({
    content: [{ arguments: {}, id: "call_1", name: "read", type: "toolCall" }],
    role: "assistant",
  } as AgentMessage);

  appendMessage({
    content: [{ text: "ok", type: "text" }],
    details: { big: "x".repeat(10_000) },
    isError: false,
    role: "toolResult",
    toolCallId: "call_1",
  } as any);
}

function getPersistedToolResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const messages = sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);

  return messages.find((m) => (m as any).role === "toolResult") as any;
}

afterEach(() => {
  resetGlobalHookRunner();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("tool_result_persist hook", () => {
  it("does not modify persisted toolResult messages when no hook is registered", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    expect(toolResult).toBeTruthy();
    expect(toolResult.details).toBeTruthy();
  });

  it("loads tool_result_persist hooks without breaking persistence", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-toolpersist-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginA = writeTempPlugin({
      body: `export default { id: "persist-a", register(api) {
  api.on("tool_result_persist", (event, ctx) => {
    const msg = event.message;
    // Example: remove large diagnostic payloads before persistence.
    const { details: _details, ...rest } = msg;
    return { message: { ...rest, persistOrder: ["a"], agentSeen: ctx.agentId ?? null } };
  }, { priority: 10 });
} };`,
      dir: tmp,
      id: "persist-a",
    });

    const pluginB = writeTempPlugin({
      body: `export default { id: "persist-b", register(api) {
  api.on("tool_result_persist", (event) => {
    const prior = (event.message && event.message.persistOrder) ? event.message.persistOrder : [];
    return { message: { ...event.message, persistOrder: [...prior, "b"] } };
  }, { priority: 5 });
} };`,
      dir: tmp,
      id: "persist-b",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["persist-a", "persist-b"],
          load: { paths: [pluginA, pluginB] },
        },
      },
      workspaceDir: tmp,
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    expect(toolResult).toBeTruthy();

    // Hook registration should preserve a valid toolResult message shape.
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_1");
    expect(Array.isArray(toolResult.content)).toBe(true);
  });
});

describe("before_message_write hook", () => {
  it("continues persistence when a before_message_write hook throws", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-before-write-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const plugin = writeTempPlugin({
      body: `export default { id: "before-write-throws", register(api) {
  api.on("before_message_write", () => {
    throw new Error("boom");
  }, { priority: 10 });
} };`,
      dir: tmp,
      id: "before-write-throws",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["before-write-throws"],
          load: { paths: [plugin] },
        },
      },
      workspaceDir: tmp,
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      content: "hello",
      role: "user",
      timestamp: Date.now(),
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });
});
