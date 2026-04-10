import { streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { appendBootstrapPromptWarning } from "../../bootstrap-budget.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../system-prompt-cache-boundary.js";
import { buildAgentSystemPrompt } from "../../system-prompt.js";
import {
  buildAfterTurnRuntimeContext,
  composeSystemPromptWithHookContext,
  decodeHtmlEntitiesInObject,
  prependSystemPromptAddition,
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveAttemptFsWorkspaceOnly,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldWarnOnOrphanedUserRepair,
  wrapStreamFnRepairMalformedToolCallArguments,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.js";

interface FakeWrappedStream {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

async function invokeWrappedTestStream(
  wrap: (
    baseFn: (...args: never[]) => unknown,
  ) => (...args: never[]) => FakeWrappedStream | Promise<FakeWrappedStream>,
  baseFn: (...args: never[]) => unknown,
): Promise<FakeWrappedStream> {
  const wrappedFn = wrap(baseFn);
  return await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
}

describe("resolvePromptBuildHookResult", () => {
  function createLegacyOnlyHookRunner() {
    return {
      hasHooks: vi.fn(
        (hookName: "before_prompt_build" | "before_agent_start") =>
          hookName === "before_agent_start",
      ),
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "from-hook" })),
      runBeforePromptBuild: vi.fn(async () => undefined),
    };
  }

  it("reuses precomputed legacy before_agent_start result without invoking hook again", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const result = await resolvePromptBuildHookResult({
      hookCtx: {},
      hookRunner,
      legacyBeforeAgentStartResult: { prependContext: "from-cache", systemPrompt: "legacy-system" },
      messages: [],
      prompt: "hello",
    });

    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result).toEqual({
      appendSystemContext: undefined,
      prependContext: "from-cache",
      prependSystemContext: undefined,
      systemPrompt: "legacy-system",
    });
  });

  it("calls legacy hook when precomputed result is absent", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const messages = [{ content: "ctx", role: "user" }];
    const result = await resolvePromptBuildHookResult({
      hookCtx: {},
      hookRunner,
      messages,
      prompt: "hello",
    });

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledWith({ messages, prompt: "hello" }, {});
    expect(result.prependContext).toBe("from-hook");
  });

  it("merges prompt-build and legacy context fields in deterministic order", async () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeAgentStart: vi.fn(async () => ({
        appendSystemContext: "legacy append",
        prependContext: "legacy context",
        prependSystemContext: "legacy prepend",
      })),
      runBeforePromptBuild: vi.fn(async () => ({
        appendSystemContext: "prompt append",
        prependContext: "prompt context",
        prependSystemContext: "prompt prepend",
      })),
    };

    const result = await resolvePromptBuildHookResult({
      hookCtx: {},
      hookRunner,
      messages: [],
      prompt: "hello",
    });

    expect(result.prependContext).toBe("prompt context\n\nlegacy context");
    expect(result.prependSystemContext).toBe("prompt prepend\n\nlegacy prepend");
    expect(result.appendSystemContext).toBe("prompt append\n\nlegacy append");
  });
});

describe("composeSystemPromptWithHookContext", () => {
  it("returns undefined when no hook system context is provided", () => {
    expect(composeSystemPromptWithHookContext({ baseSystemPrompt: "base" })).toBeUndefined();
  });

  it("builds prepend/base/append system prompt order", () => {
    expect(
      composeSystemPromptWithHookContext({
        appendSystemContext: "  append  ",
        baseSystemPrompt: "  base system  ",
        prependSystemContext: "  prepend  ",
      }),
    ).toBe("prepend\n\nbase system\n\nappend");
  });

  it("normalizes hook system context line endings and trailing whitespace", () => {
    expect(
      composeSystemPromptWithHookContext({
        appendSystemContext: "  append  \t\r\n",
        baseSystemPrompt: "  base system  ",
        prependSystemContext: "  prepend line  \r\nsecond line\t\r\n",
      }),
    ).toBe("prepend line\nsecond line\n\nbase system\n\nappend");
  });

  it("avoids blank separators when base system prompt is empty", () => {
    expect(
      composeSystemPromptWithHookContext({
        appendSystemContext: "  append only  ",
        baseSystemPrompt: "   ",
      }),
    ).toBe("append only");
  });

  it("keeps hook-composed system prompt stable when bootstrap warnings only change the user prompt", () => {
    const baseSystemPrompt = buildAgentSystemPrompt({
      contextFiles: [{ content: "Follow AGENTS guidance.", path: "AGENTS.md" }],
      toolNames: ["read"],
      workspaceDir: "/tmp/openclaw",
    });
    const composedSystemPrompt = composeSystemPromptWithHookContext({
      appendSystemContext: "hook system context",
      baseSystemPrompt,
    });
    const turns = [
      {
        prompt: appendBootstrapPromptWarning("hello", ["AGENTS.md: 200 raw -> 0 injected"]),
        systemPrompt: composedSystemPrompt,
      },
      {
        prompt: appendBootstrapPromptWarning("hello again", []),
        systemPrompt: composedSystemPrompt,
      },
      {
        prompt: appendBootstrapPromptWarning("hello once more", [
          "AGENTS.md: 200 raw -> 0 injected",
        ]),
        systemPrompt: composedSystemPrompt,
      },
    ];

    expect(turns[0]?.systemPrompt).toBe(turns[1]?.systemPrompt);
    expect(turns[1]?.systemPrompt).toBe(turns[2]?.systemPrompt);
    expect(turns[0]?.prompt.startsWith("hello")).toBe(true);
    expect(turns[1]?.prompt).toBe("hello again");
    expect(turns[2]?.prompt.startsWith("hello once more")).toBe(true);
    expect(turns[0]?.prompt).toContain("[Bootstrap truncation warning]");
    expect(turns[2]?.prompt).toContain("[Bootstrap truncation warning]");
  });
});

describe("resolvePromptModeForSession", () => {
  it("uses minimal mode for subagent sessions", () => {
    expect(resolvePromptModeForSession("agent:main:subagent:child")).toBe("minimal");
  });

  it("uses minimal mode for cron sessions", () => {
    expect(resolvePromptModeForSession("agent:main:cron:job-1")).toBe("minimal");
    expect(resolvePromptModeForSession("agent:main:cron:job-1:run:run-abc")).toBe("minimal");
  });

  it("uses full mode for regular and undefined sessions", () => {
    expect(resolvePromptModeForSession(undefined)).toBe("full");
    expect(resolvePromptModeForSession("agent:main")).toBe("full");
    expect(resolvePromptModeForSession("agent:main:thread:abc")).toBe("full");
  });
});

describe("shouldWarnOnOrphanedUserRepair", () => {
  it("warns for user and manual runs", () => {
    expect(shouldWarnOnOrphanedUserRepair("user")).toBe(true);
    expect(shouldWarnOnOrphanedUserRepair("manual")).toBe(true);
  });

  it("does not warn for background triggers", () => {
    expect(shouldWarnOnOrphanedUserRepair("heartbeat")).toBe(false);
    expect(shouldWarnOnOrphanedUserRepair("cron")).toBe(false);
    expect(shouldWarnOnOrphanedUserRepair("memory")).toBe(false);
    expect(shouldWarnOnOrphanedUserRepair("overflow")).toBe(false);
  });
});

describe("resolveEmbeddedAgentStreamFn", () => {
  it("reuses the session's original base stream across later wrapper mutations", () => {
    resetEmbeddedAgentBaseStreamFnCacheForTest();
    const baseStreamFn = vi.fn();
    const wrapperStreamFn = vi.fn();
    const session = {
      agent: {
        streamFn: baseStreamFn,
      },
    };

    expect(resolveEmbeddedAgentBaseStreamFn({ session })).toBe(baseStreamFn);
    session.agent.streamFn = wrapperStreamFn;
    expect(resolveEmbeddedAgentBaseStreamFn({ session })).toBe(baseStreamFn);
  });

  it("injects authStorage api keys into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const streamFn = resolveEmbeddedAgentStreamFn({
      authStorage: {
        getApiKey: vi.fn(async () => "demo-runtime-key"),
      },
      currentStreamFn: undefined,
      model: {
        api: "openai-completions",
        id: "demo-model",
        provider: "demo-provider",
      } as never,
      providerStreamFn,
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
    });

    await expect(
      streamFn({ id: "demo-model", provider: "demo-provider" } as never, {} as never, {}),
    ).resolves.toMatchObject({
      apiKey: "demo-runtime-key",
    });
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("strips the internal cache boundary before provider-owned stream calls", async () => {
    const providerStreamFn = vi.fn(async (_model, context) => context);
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      model: {
        api: "openai-completions",
        id: "demo-model",
        provider: "demo-provider",
      } as never,
      providerStreamFn,
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
    });

    await expect(
      streamFn(
        { id: "demo-model", provider: "demo-provider" } as never,
        {
          systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        } as never,
        {},
      ),
    ).resolves.toMatchObject({
      systemPrompt: "Stable prefix\nDynamic suffix",
    });
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });
  it("routes supported default streamSimple fallbacks through boundary-aware transports", () => {
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: undefined,
      model: {
        api: "openai-responses",
        id: "gpt-5.4",
        provider: "openai",
      } as never,
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
    });

    expect(streamFn).not.toBe(streamSimple);
  });

  it("keeps explicit custom currentStreamFn values unchanged", () => {
    const currentStreamFn = vi.fn();
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: currentStreamFn as never,
      model: {
        api: "openai-responses",
        id: "gpt-5.4",
        provider: "openai",
      } as never,
      sessionId: "session-1",
      shouldUseWebSocketTransport: false,
    });

    expect(streamFn).toBe(currentStreamFn);
  });
});

describe("resolveAttemptFsWorkspaceOnly", () => {
  it("uses global tools.fs.workspaceOnly when agent has no override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
      tools: {
        fs: { workspaceOnly: true },
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(false);
  });
});
describe("wrapStreamFnTrimToolCallNames", () => {
  async function invokeWrappedStream(
    baseFn: (...args: never[]) => unknown,
    allowedToolNames?: Set<string>,
  ) {
    return await invokeWrappedTestStream(
      (innerBaseFn) => wrapStreamFnTrimToolCallNames(innerBaseFn as never, allowedToolNames),
      baseFn,
    );
  }

  function createEventStream(params: {
    event: unknown;
    finalToolCall: { type: string; name: string };
  }) {
    const finalMessage = { content: [params.finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({ events: [params.event], resultMessage: finalMessage }),
    );
    return { baseFn, finalMessage };
  }

  it("trims whitespace from live streamed tool call names and final result message", async () => {
    const partialToolCall = { name: " read ", type: "toolCall" };
    const messageToolCall = { name: " exec ", type: "toolCall" };
    const finalToolCall = { name: " write ", type: "toolCall" };
    const event = {
      message: { content: [messageToolCall], role: "assistant" },
      partial: { content: [partialToolCall], role: "assistant" },
      type: "toolcall_delta",
    };
    const { baseFn, finalMessage } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    const seenEvents: unknown[] = [];
    for await (const item of stream) {
      seenEvents.push(item);
    }
    const result = await stream.result();

    expect(seenEvents).toHaveLength(1);
    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("supports async stream functions that return a promise", async () => {
    const finalToolCall = { name: " browser ", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    const result = await stream.result();

    expect(finalToolCall.name).toBe("browser");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });
  it("normalizes common tool aliases when the canonical name is allowed", async () => {
    const finalToolCall = { name: " BASH ", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("maps provider-prefixed tool names to allowed canonical tools", async () => {
    const partialToolCall = { name: " functions.read ", type: "toolCall" };
    const messageToolCall = { name: " functions.write ", type: "toolCall" };
    const finalToolCall = { name: " tools/exec ", type: "toolCall" };
    const event = {
      message: { content: [messageToolCall], role: "assistant" },
      partial: { content: [partialToolCall], role: "assistant" },
      type: "toolcall_delta",
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // Drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("write");
    expect(finalToolCall.name).toBe("exec");
  });

  it("normalizes toolUse and functionCall names before dispatch", async () => {
    const partialToolCall = { name: " functions.read ", type: "toolUse" };
    const messageToolCall = { name: " functions.exec ", type: "functionCall" };
    const finalToolCall = { name: " tools/write ", type: "toolUse" };
    const event = {
      message: { content: [messageToolCall], role: "assistant" },
      partial: { content: [partialToolCall], role: "assistant" },
      type: "toolcall_delta",
    };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // Drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
  });

  it("preserves multi-segment tool suffixes when dropping provider prefixes", async () => {
    const finalToolCall = { name: " functions.graph.search ", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["graph.search", "search"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("graph.search");
    expect(result).toBe(finalMessage);
  });

  it("infers tool names from malformed toolCallId variants when allowlist is present", async () => {
    const partialToolCall = { id: "functions.read:0", name: "", type: "toolCall" };
    const finalToolCallA = { id: "functionsread3", name: "", type: "toolCall" };
    const finalToolCallB: { type: string; id: string; name?: string } = {
      id: "functionswrite4",
      type: "toolCall",
    };
    const finalToolCallC = { id: "functions.exec2", name: "", type: "functionCall" };
    const event = {
      partial: { content: [partialToolCall], role: "assistant" },
      type: "toolcall_delta",
    };
    const finalMessage = {
      content: [finalToolCallA, finalToolCallB, finalToolCallC],
      role: "assistant",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));
    for await (const _item of stream) {
      // Drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallC.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("does not infer names from malformed toolCallId when allowlist is absent", async () => {
    const finalToolCall: { type: string; id: string; name?: string } = {
      id: "functionsread3",
      type: "toolCall",
    };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
  });

  it("infers malformed non-blank tool names before dispatch", async () => {
    const partialToolCall = { id: "functionsread3", name: "functionsread3", type: "toolCall" };
    const finalToolCall = { id: "functionsread3", name: "functionsread3", type: "toolCall" };
    const event = {
      partial: { content: [partialToolCall], role: "assistant" },
      type: "toolcall_delta",
    };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    for await (const _item of stream) {
      // Drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCall.name).toBe("read");
  });

  it("recovers malformed non-blank names when id is missing", async () => {
    const finalToolCall = { name: "functionsread3", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers canonical tool names from canonical ids when name is empty", async () => {
    const finalToolCall = { id: "read", name: "", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers tool names from ids when name is whitespace-only", async () => {
    const finalToolCall = { id: "functionswrite4", name: "   ", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("write");
  });

  it("keeps blank names blank and assigns fallback ids when both name and id are blank", async () => {
    const finalToolCall = { id: "", name: "", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("");
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  it("assigns fallback ids when both name and id are missing", async () => {
    const finalToolCall: { type: string; name?: string; id?: string } = { type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  it("prefers explicit canonical names over conflicting canonical ids", async () => {
    const finalToolCall = { id: "write", name: "read", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("write");
  });

  it("prefers explicit trimmed canonical names over conflicting malformed ids", async () => {
    const finalToolCall = { id: "functionswrite4", name: " read ", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("does not rewrite composite names that mention multiple tools", async () => {
    const finalToolCall = { id: "functionsread3", name: "read write", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read write");
  });

  it("fails closed for malformed non-blank names that are ambiguous", async () => {
    const finalToolCall = { id: "functions.exec2", name: "functions.exec2", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(finalToolCall.name).toBe("functions.exec2");
  });

  it("matches malformed ids case-insensitively across common separators", async () => {
    const finalToolCall = { id: "Functions.Read_7", name: "", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });
  it("does not override explicit non-blank tool names with inferred ids", async () => {
    const finalToolCall = { id: "functionswrite4", name: "someOtherTool", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("someOtherTool");
  });

  it("fails closed when malformed ids could map to multiple allowlisted tools", async () => {
    const finalToolCall = { id: "functions.exec2", name: "", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(finalToolCall.name).toBe("");
  });
  it("does not collapse whitespace-only tool names to empty strings", async () => {
    const partialToolCall = { name: "   ", type: "toolCall" };
    const finalToolCall = { name: "\t  ", type: "toolCall" };
    const event = {
      partial: { content: [partialToolCall], role: "assistant" },
      type: "toolcall_delta",
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    for await (const _item of stream) {
      // Drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("   ");
    expect(finalToolCall.name).toBe("\t  ");
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("assigns fallback ids to missing/blank tool call ids in streamed and final messages", async () => {
    const partialToolCall = { id: "   ", name: " read ", type: "toolCall" };
    const finalToolCallA = { id: "", name: " exec ", type: "toolCall" };
    const finalToolCallB: { type: string; name: string; id?: string } = {
      name: " write ",
      type: "toolCall",
    };
    const event = {
      partial: { content: [partialToolCall], role: "assistant" },
      type: "toolcall_delta",
    };
    const finalMessage = { content: [finalToolCallA, finalToolCallB], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(partialToolCall.id).toBe("call_auto_1");
    expect(finalToolCallA.name).toBe("exec");
    expect(finalToolCallA.id).toBe("call_auto_1");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallB.id).toBe("call_auto_2");
    expect(result).toBe(finalMessage);
  });

  it("trims surrounding whitespace on tool call ids", async () => {
    const finalToolCall = { id: "  call_42  ", name: " read ", type: "toolCall" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("call_42");
  });

  it("reassigns duplicate tool call ids within a message to unique fallbacks", async () => {
    const finalToolCallA = { id: "  edit:22  ", name: " read ", type: "toolCall" };
    const finalToolCallB = { id: "edit:22", name: " write ", type: "toolCall" };
    const finalMessage = { content: [finalToolCallA, finalToolCallB], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallA.id).toBe("edit:22");
    expect(finalToolCallB.id).toBe("call_auto_1");
  });
});

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  it("drops malformed assistant tool calls from outbound context before provider replay", async () => {
    const messages = [
      {
        content: [{ arguments: {}, name: "read", type: "toolCall" }],
        role: "assistant",
        stopReason: "error",
      },
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ]);
    expect(seenContext.messages).not.toBe(messages);
  });

  it("preserves outbound context when all assistant tool calls are valid", async () => {
    const messages = [
      {
        content: [{ arguments: {}, id: "call_1", name: "read", type: "toolCall" }],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toBe(messages);
  });

  it("preserves sessions_spawn attachment payloads on replay", async () => {
    const attachmentContent = "INLINE_ATTACHMENT_PAYLOAD";
    const messages = [
      {
        content: [
          {
            id: "call_1",
            input: {
              attachments: [{ name: "snapshot.txt", content: attachmentContent }],
              task: "inspect attachment",
            },
            name: "  SESSIONS_SPAWN  ",
            type: "toolUse",
          },
        ],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["sessions_spawn"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { content?: Record<string, unknown>[] }[];
    };
    const toolCall = seenContext.messages[0]?.content?.[0] as {
      name?: string;
      input?: { attachments?: { content?: string }[] };
    };
    expect(toolCall.name).toBe("sessions_spawn");
    expect(toolCall.input?.attachments?.[0]?.content).toBe(attachmentContent);
  });

  it("preserves allowlisted tool names that contain punctuation", async () => {
    const messages = [
      {
        content: [{ id: "call_1", input: { scope: "all" }, name: "admin.export", type: "toolUse" }],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["admin.export"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toBe(messages);
  });

  it("normalizes provider-prefixed replayed tool names before provider replay", async () => {
    const messages = [
      {
        content: [{ id: "call_1", input: { path: "." }, name: "functions.read", type: "toolUse" }],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { content?: { name?: string }[] }[];
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("read");
  });

  it("canonicalizes mixed-case allowlisted tool names on replay", async () => {
    const messages = [
      {
        content: [{ arguments: {}, id: "call_1", name: "readfile", type: "toolCall" }],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["ReadFile"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { content?: { name?: string }[] }[];
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("ReadFile");
  });

  it("recovers blank replayed tool names from their ids", async () => {
    const messages = [
      {
        content: [{ arguments: {}, id: "functionswrite4", name: "   ", type: "toolCall" }],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["write"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { content?: { name?: string }[] }[];
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("write");
  });

  it("recovers mangled replayed tool names before dropping the call", async () => {
    const messages = [
      {
        content: [{ arguments: {}, id: "call_1", name: "functionsread3", type: "toolCall" }],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { content?: { name?: string }[] }[];
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("read");
  });

  it("drops orphaned tool results after replay sanitization removes a tool-call turn", async () => {
    const messages = [
      {
        content: [{ arguments: {}, name: "read", type: "toolCall" }],
        role: "assistant",
        stopReason: "error",
      },
      {
        content: [{ text: "stale result", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_missing",
        toolName: "read",
      },
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { role?: string }[];
    };
    expect(seenContext.messages).toEqual([
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ]);
  });

  it("drops replayed tool calls that are no longer allowlisted", async () => {
    const messages = [
      {
        content: [{ arguments: {}, id: "call_1", name: "write", type: "toolCall" }],
        role: "assistant",
      },
      {
        content: [{ text: "stale result", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "write",
      },
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { role?: string }[];
    };
    expect(seenContext.messages).toEqual([
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ]);
  });
  it("drops replayed tool names that are no longer allowlisted", async () => {
    const messages = [
      {
        content: [{ id: "call_1", input: { path: "." }, name: "unknown_tool", type: "toolUse" }],
        role: "assistant",
      },
      {
        content: [{ text: "stale result", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "unknown_tool",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([]);
  });

  it("drops ambiguous mangled replay names instead of guessing a tool", async () => {
    const messages = [
      {
        content: [{ arguments: {}, id: "call_1", name: "functions.exec2", type: "toolCall" }],
        role: "assistant",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["exec", "exec2"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([]);
  });

  it("preserves matching tool results for retained errored assistant turns", async () => {
    const messages = [
      {
        content: [
          { arguments: {}, id: "call_1", name: "read", type: "toolCall" },
          { arguments: {}, name: "read", type: "toolCall" },
        ],
        role: "assistant",
        stopReason: "error",
      },
      {
        content: [{ text: "kept result", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
      },
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([
      {
        content: [{ arguments: {}, id: "call_1", name: "read", type: "toolCall" }],
        role: "assistant",
        stopReason: "error",
      },
      {
        content: [{ text: "kept result", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
      },
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ]);
  });

  it("revalidates turn ordering after dropping an assistant replay turn", async () => {
    const messages = [
      {
        content: [{ text: "first", type: "text" }],
        role: "user",
      },
      {
        content: [{ arguments: {}, name: "read", type: "toolCall" }],
        role: "assistant",
        stopReason: "error",
      },
      {
        content: [{ text: "second", type: "text" }],
        role: "user",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      validateGeminiTurns: false,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { role?: string; content?: unknown[] }[];
    };
    expect(seenContext.messages).toEqual([
      {
        content: [
          { text: "first", type: "text" },
          { text: "second", type: "text" },
        ],
        role: "user",
      },
    ]);
  });

  it("drops orphaned Anthropic user tool_result blocks after replay sanitization", async () => {
    const messages = [
      {
        content: [
          { text: "partial response", type: "text" },
          { input: { path: "." }, name: "read", type: "toolUse" },
        ],
        role: "assistant",
      },
      {
        content: [
          { content: [{ type: "text", text: "stale" }], toolUseId: "call_1", type: "toolResult" },
          { text: "retry", type: "text" },
        ],
        role: "user",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      validateGeminiTurns: false,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { role?: string; content?: unknown[] }[];
    };
    expect(seenContext.messages).toEqual([
      {
        content: [{ text: "partial response", type: "text" }],
        role: "assistant",
      },
      {
        content: [{ text: "retry", type: "text" }],
        role: "user",
      },
    ]);
  });

  it.each(["toolCall", "functionCall"] as const)(
    "preserves matching Anthropic user tool_result blocks after %s replay turns",
    async (toolCallType) => {
      const messages = [
        {
          content: [{ arguments: {}, id: "call_1", name: "read", type: toolCallType }],
          role: "assistant",
        },
        {
          content: [
            {
              content: [{ type: "text", text: "kept result" }],
              toolUseId: "call_1",
              type: "toolResult",
            },
            { text: "retry", type: "text" },
          ],
          role: "user",
        },
      ];
      const baseFn = vi.fn((_model, _context) =>
        createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
      );

      const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
        validateAnthropicTurns: true,
        validateGeminiTurns: false,
      });
      const stream = wrapped({} as never, { messages } as never, {} as never) as
        | FakeWrappedStream
        | Promise<FakeWrappedStream>;
      await Promise.resolve(stream);

      expect(baseFn).toHaveBeenCalledTimes(1);
      const seenContext = baseFn.mock.calls[0]?.[1] as {
        messages: { role?: string; content?: unknown[] }[];
      };
      expect(seenContext.messages).toEqual(messages);
    },
  );

  it("drops orphaned Anthropic user tool_result blocks after dropping an assistant replay turn", async () => {
    const messages = [
      {
        content: [{ text: "first", type: "text" }],
        role: "user",
      },
      {
        content: [{ input: { path: "." }, name: "read", type: "toolUse" }],
        role: "assistant",
        stopReason: "error",
      },
      {
        content: [
          { content: [{ type: "text", text: "stale" }], toolUseId: "call_1", type: "toolResult" },
          { text: "second", type: "text" },
        ],
        role: "user",
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { content: [], role: "assistant" } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      validateGeminiTurns: false,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: { role?: string; content?: unknown[] }[];
    };
    expect(seenContext.messages).toEqual([
      {
        content: [
          { text: "first", type: "text" },
          { text: "second", type: "text" },
        ],
        role: "user",
      },
    ]);
  });
});

describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  async function invokeWrappedStream(baseFn: (...args: never[]) => unknown) {
    return await invokeWrappedTestStream(
      (innerBaseFn) => wrapStreamFnRepairMalformedToolCallArguments(innerBaseFn as never),
      baseFn,
    );
  }

  it("repairs anthropic-compatible tool arguments when trailing junk follows valid JSON", async () => {
    const partialToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const streamedToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const endMessageToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const finalToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const endMessage = { content: [endMessageToolCall], role: "assistant" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            delta: "xx",
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            message: endMessage,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  it("repairs tool arguments when malformed tool-call preamble appears before JSON", async () => {
    const partialToolCall = { arguments: {}, name: "write", type: "toolCall" };
    const streamedToolCall = { arguments: {}, name: "write", type: "toolCall" };
    const endMessageToolCall = { arguments: {}, name: "write", type: "toolCall" };
    const finalToolCall = { arguments: {}, name: "write", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const endMessage = { content: [endMessageToolCall], role: "assistant" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: '.functions.write:8  \n{"path":"/tmp/report.txt"}',
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            message: endMessage,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });
  it("preserves anthropic-compatible tool arguments when the streamed JSON is already valid", async () => {
    const partialToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const streamedToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const endMessageToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const finalToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const endMessage = { content: [endMessageToolCall], role: "assistant" };
    const finalMessage = { content: [finalToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"',
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            delta: "}",
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            message: endMessage,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  it("does not repair tool arguments when leading text is not tool-call metadata", async () => {
    const partialToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const streamedToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: 'please use {"path":"/tmp/report.txt"}',
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: { content: [partialToolCall], role: "assistant" },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });

  it("keeps incomplete partial JSON unchanged until a complete object exists", async () => {
    const partialToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: '{"path":"/tmp',
            partial: partialMessage,
            type: "toolcall_delta",
          },
        ],
        resultMessage: { content: [partialToolCall], role: "assistant" },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }

    expect(partialToolCall.arguments).toEqual({});
  });

  it("does not repair tool arguments when trailing junk exceeds the Kimi-specific allowance", async () => {
    const partialToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const streamedToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}oops',
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: { content: [partialToolCall], role: "assistant" },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });

  it("clears a cached repair when later deltas make the trailing suffix invalid", async () => {
    const partialToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const streamedToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            delta: "x",
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            delta: "yzq",
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: { content: [partialToolCall], role: "assistant" },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });

  it("clears a cached repair when a later delta adds a single oversized trailing suffix", async () => {
    const partialToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const streamedToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            delta: "oops",
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: { content: [partialToolCall], role: "assistant" },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });

  it("preserves preexisting tool arguments when later reevaluation fails", async () => {
    const partialToolCall = {
      arguments: { path: "/etc/hosts" },
      name: "read",
      type: "toolCall",
    };
    const streamedToolCall = { arguments: {}, name: "read", type: "toolCall" };
    const partialMessage = { content: [partialToolCall], role: "assistant" };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            contentIndex: 0,
            delta: "}",
            partial: partialMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 0,
            partial: partialMessage,
            toolCall: streamedToolCall,
            type: "toolcall_end",
          },
        ],
        resultMessage: { content: [partialToolCall], role: "assistant" },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // Drain
    }

    expect(partialToolCall.arguments).toEqual({ path: "/etc/hosts" });
    expect(streamedToolCall.arguments).toEqual({});
  });
});

describe("decodeHtmlEntitiesInObject", () => {
  it("decodes HTML entities in string values", () => {
    const result = decodeHtmlEntitiesInObject(
      "source .env &amp;&amp; psql &quot;$DB&quot; -c &lt;query&gt;",
    );
    expect(result).toBe('source .env && psql "$DB" -c <query>');
  });

  it("recursively decodes nested objects", () => {
    const input = {
      args: ["--flag=&quot;value&quot;", "&lt;input&gt;"],
      command: "cd ~/dev &amp;&amp; npm run build",
      nested: { deep: "a &amp; b" },
    };
    const result = decodeHtmlEntitiesInObject(input) as Record<string, unknown>;
    expect(result.command).toBe("cd ~/dev && npm run build");
    expect((result.args as string[])[0]).toBe('--flag="value"');
    expect((result.args as string[])[1]).toBe("<input>");
    expect((result.nested as Record<string, string>).deep).toBe("a & b");
  });

  it("passes through non-string primitives unchanged", () => {
    expect(decodeHtmlEntitiesInObject(42)).toBe(42);
    expect(decodeHtmlEntitiesInObject(null)).toBe(null);
    expect(decodeHtmlEntitiesInObject(true)).toBe(true);
    expect(decodeHtmlEntitiesInObject(undefined)).toBe(undefined);
  });

  it("returns strings without entities unchanged", () => {
    const input = "plain string with no entities";
    expect(decodeHtmlEntitiesInObject(input)).toBe(input);
  });

  it("decodes numeric character references", () => {
    expect(decodeHtmlEntitiesInObject("&#39;hello&#39;")).toBe("'hello'");
    expect(decodeHtmlEntitiesInObject("&#x27;world&#x27;")).toBe("'world'");
  });
});
describe("prependSystemPromptAddition", () => {
  it("prepends context-engine addition to the system prompt", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
      systemPromptAddition: "extra behavior",
    });

    expect(result).toBe("extra behavior\n\nbase system");
  });

  it("returns the original system prompt when no addition is provided", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
    });

    expect(result).toBe("base system");
  });
});

describe("buildAfterTurnRuntimeContext", () => {
  it("uses primary model when compaction.model is not set", () => {
    const legacy = buildAfterTurnRuntimeContext({
      agentDir: "/tmp/agent",
      attempt: {
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        extraSystemPrompt: "extra",
        messageChannel: "slack",
        messageProvider: "slack",
        modelId: "gpt-5.4",
        ownerNumbers: ["+15555550123"],
        provider: "openai-codex",
        reasoningLevel: "on",
        senderIsOwner: true,
        sessionKey: "agent:main:session:abc",
        skillsSnapshot: undefined,
        thinkLevel: "off",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(legacy).toMatchObject({
      model: "gpt-5.4",
      provider: "openai-codex",
    });
  });

  it("resolves compaction.model override in runtime context so all context engines use the correct model", () => {
    const legacy = buildAfterTurnRuntimeContext({
      agentDir: "/tmp/agent",
      attempt: {
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openrouter/anthropic/claude-sonnet-4-5",
              },
            },
          },
        } as OpenClawConfig,
        extraSystemPrompt: "extra",
        messageChannel: "slack",
        messageProvider: "slack",
        modelId: "gpt-5.4",
        ownerNumbers: ["+15555550123"],
        provider: "openai-codex",
        reasoningLevel: "on",
        senderIsOwner: true,
        sessionKey: "agent:main:session:abc",
        skillsSnapshot: undefined,
        thinkLevel: "off",
      },
      workspaceDir: "/tmp/workspace",
    });

    // BuildEmbeddedCompactionRuntimeContext now resolves the override eagerly
    // So that context engines (including third-party ones) receive the correct
    // Compaction model in the runtime context.
    expect(legacy).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-5",
      // Auth profile dropped because provider changed from openai-codex to openrouter
      authProfileId: undefined,
    });
  });
  it("includes resolved auth profile fields for context-engine afterTurn compaction", () => {
    const legacy = buildAfterTurnRuntimeContext({
      agentDir: "/tmp/agent",
      attempt: {
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        extraSystemPrompt: "extra",
        messageChannel: "slack",
        messageProvider: "slack",
        modelId: "gpt-5.4",
        ownerNumbers: ["+15555550123"],
        provider: "openai-codex",
        reasoningLevel: "on",
        senderIsOwner: true,
        sessionKey: "agent:main:session:abc",
        skillsSnapshot: undefined,
        thinkLevel: "off",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(legacy).toMatchObject({
      agentDir: "/tmp/agent",
      authProfileId: "openai:p1",
      model: "gpt-5.4",
      provider: "openai-codex",
      workspaceDir: "/tmp/workspace",
    });
  });

  it("preserves sender and channel routing context for scoped compaction discovery", () => {
    const legacy = buildAfterTurnRuntimeContext({
      agentDir: "/tmp/agent",
      attempt: {
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        currentChannelId: "C123",
        currentMessageId: "msg-42",
        currentThreadTs: "thread-9",
        extraSystemPrompt: "extra",
        messageChannel: "slack",
        messageProvider: "slack",
        modelId: "gpt-5.4",
        ownerNumbers: ["+15555550123"],
        provider: "openai-codex",
        reasoningLevel: "on",
        senderId: "user-123",
        senderIsOwner: true,
        sessionKey: "agent:main:session:abc",
        skillsSnapshot: undefined,
        thinkLevel: "off",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(legacy).toMatchObject({
      currentChannelId: "C123",
      currentMessageId: "msg-42",
      currentThreadTs: "thread-9",
      senderId: "user-123",
    });
  });
});
