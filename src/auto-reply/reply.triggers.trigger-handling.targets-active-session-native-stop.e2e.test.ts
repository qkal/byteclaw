import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, resolveSessionKey } from "../config/sessions.js";
import { registerGroupIntroPromptCases } from "./reply.triggers.group-intro-prompts.cases.js";
import { registerTriggerHandlingUsageSummaryCases } from "./reply.triggers.trigger-handling.filters-usage-summary-current-model-provider.cases.js";
import {
  MAIN_SESSION_KEY,
  expectInlineCommandHandledAndStripped,
  getAbortEmbeddedPiRunMock,
  getCompactEmbeddedPiSessionMock,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingReplyHarness,
  makeCfg,
  mockRunEmbeddedPiAgentOk,
  requireSessionStorePath,
  runGreetingPromptForBareNewOrReset,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";
import { withFullRuntimeReplyConfig } from "./reply/get-reply-fast-path.js";
import { type FollowupRun, enqueueFollowupRun, getFollowupQueueDepth } from "./reply/queue.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

type GetReplyFromConfig = typeof import("./reply.js").getReplyFromConfig;

const TEST_PRIMARY_PROFILE_ID = "openai-codex:primary@example.test";
const TEST_SECONDARY_PROFILE_ID = "openai-codex:secondary@example.test";

vi.mock("./reply/agent-runner.runtime.js", () => ({
  runReplyAgent: async (params: {
    commandBody: string;
    followupRun: {
      run: {
        provider: string;
        model: string;
        authProfileId?: string;
        authProfileIdSource?: "auto" | "user";
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        workspaceDir: string;
        config: object;
        extraSystemPrompt?: string;
      };
    };
  }) => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    const normalizeErrorText = (message: string) => {
      if (/context window exceeded/i.test(message)) {
        return "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model.";
      }
      const trimmed = message.replace(/\.\s*$/, "");
      return `⚠️ Agent failed before reply: ${trimmed}.\nLogs: openclaw logs --follow`;
    };
    const stripHeartbeat = (text?: string) => {
      const trimmed = text?.trim();
      if (!trimmed || trimmed === HEARTBEAT_TOKEN) {
        return undefined;
      }
      return trimmed.startsWith(`${HEARTBEAT_TOKEN} `)
        ? trimmed.slice(HEARTBEAT_TOKEN.length).trimStart()
        : trimmed;
    };

    try {
      const result = await runEmbeddedPiAgentMock({
        authProfileId: params.followupRun.run.authProfileId,
        authProfileIdSource: params.followupRun.run.authProfileIdSource,
        config: params.followupRun.run.config,
        extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
        model: params.followupRun.run.model,
        prompt: params.commandBody,
        provider: params.followupRun.run.provider,
        sessionFile: params.followupRun.run.sessionFile,
        sessionId: params.followupRun.run.sessionId,
        sessionKey: params.followupRun.run.sessionKey,
        workspaceDir: params.followupRun.run.workspaceDir,
      });
      return { text: stripHeartbeat(result?.payloads?.[0]?.text) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: normalizeErrorText(message) };
    }
  },
}));

let getReplyFromConfig!: GetReplyFromConfig;
installTriggerHandlingReplyHarness((impl) => {
  getReplyFromConfig = impl;
});

const BASE_MESSAGE = {
  Body: "hello",
  From: "+1002",
  To: "+2000",
} as const;

function maybeReplyText(reply: Awaited<ReturnType<GetReplyFromConfig>>) {
  return Array.isArray(reply) ? reply[0]?.text : reply?.text;
}

function mockEmbeddedOkPayload() {
  return mockRunEmbeddedPiAgentOk("ok");
}

async function writeStoredModelOverride(cfg: ReturnType<typeof makeCfg>): Promise<void> {
  await fs.writeFile(
    requireSessionStorePath(cfg),
    JSON.stringify({
      [MAIN_SESSION_KEY]: {
        modelOverride: "gpt-5.4",
        providerOverride: "openai",
        sessionId: "main",
        updatedAt: Date.now(),
      },
    }),
    "utf8",
  );
}

function mockSuccessfulCompaction() {
  getCompactEmbeddedPiSessionMock().mockResolvedValue({
    compacted: true,
    ok: true,
    result: {
      firstKeptEntryId: "x",
      summary: "summary",
      tokensBefore: 12_000,
    },
  });
}

function makeUnauthorizedWhatsAppCfg(home: string) {
  const baseCfg = makeCfg(home);
  return {
    ...baseCfg,
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        allowFrom: ["+1000"],
      },
    },
  };
}

async function expectResetBlockedForNonOwner(params: { home: string }): Promise<void> {
  const { home } = params;
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  runEmbeddedPiAgentMock.mockClear();
  const cfg = makeCfg(home);
  cfg.channels ??= {};
  cfg.channels.whatsapp = {
    ...cfg.channels.whatsapp,
    allowFrom: ["+1999"],
  };
  cfg.commands = {
    ...cfg.commands,
    ownerAllowFrom: ["whatsapp:+1999"],
  };
  cfg.session = {
    ...cfg.session,
    store: join(home, "blocked-reset.sessions.json"),
  };
  const res = await getReplyFromConfig(
    {
      Body: "/reset",
      CommandAuthorized: false,
      From: "+1003",
      To: "+2000",
    },
    {},
    cfg,
  );
  expect(res).toBeUndefined();
  expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
}

function mockEmbeddedOk() {
  return mockRunEmbeddedPiAgentOk("ok");
}

async function runInlineUnauthorizedCommand(params: { home: string; command: "/status" }) {
  const cfg = makeUnauthorizedWhatsAppCfg(params.home);
  const res = await getReplyFromConfig(
    {
      Body: `please ${params.command} now`,
      From: "+2001",
      Provider: "whatsapp",
      SenderE164: "+2001",
      To: "+2000",
    },
    {},
    cfg,
  );
  return res;
}

describe("trigger handling", () => {
  registerGroupIntroPromptCases();
  registerTriggerHandlingUsageSummaryCases({
    getReplyFromConfig: () => getReplyFromConfig,
  });

  for (const testCase of [
    {
      error: "sandbox is not defined.",
      expected:
        "⚠️ Agent failed before reply: sandbox is not defined.\nLogs: openclaw logs --follow",
    },
    {
      error: "Context window exceeded",
      expected:
        "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model.",
    },
  ] as const) {
    it(`surfaces agent error: ${testCase.error}`, async () => {
      await withTempHome(async (home) => {
        const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
        runEmbeddedPiAgentMock.mockReset();
        runEmbeddedPiAgentMock.mockImplementation(async () => {
          throw new Error(testCase.error);
        });
        const errorRes = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));
        expect(maybeReplyText(errorRes), testCase.error).toBe(testCase.expected);
        expect(runEmbeddedPiAgentMock, testCase.error).toHaveBeenCalledOnce();
      });
    });
  }

  it("strips heartbeat-only replies and preserves normal text", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      const tokenCases = [
        { expected: undefined, text: HEARTBEAT_TOKEN },
        { expected: "hello", text: `${HEARTBEAT_TOKEN} hello` },
      ] as const;

      for (const testCase of tokenCases) {
        runEmbeddedPiAgentMock.mockReset();
        runEmbeddedPiAgentMock.mockResolvedValue({
          meta: {
            agentMeta: { model: "m", provider: "p", sessionId: "s" },
            durationMs: 1,
          },
          payloads: [{ text: testCase.text }],
        });
        const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));
        expect(maybeReplyText(res)).toBe(testCase.expected);
        expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      }
    });
  });

  it("sanitizes thinking directives before the agent run", async () => {
    await withTempHome(async (home) => {
      const thinkCases = [
        {
          assertPrompt: true,
          label: "context-wrapper",
          options: {},
          request: {
            Body: [
              "[Chat messages since your last reply - for context]",
              "Peter: /thinking high [2025-12-05T21:45:00.000Z]",
              "",
              "[Current message - respond to this]",
              "Give me the status",
            ].join("\n"),
            From: "+1002",
            To: "+2000",
          },
        },
        {
          assertPrompt: false,
          label: "heartbeat",
          options: { isHeartbeat: true },
          request: {
            Body: "HEARTBEAT /think:high",
            From: "+1003",
            To: "+1003",
          },
        },
      ] as const;

      for (const testCase of thinkCases) {
        const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
        runEmbeddedPiAgentMock.mockReset();
        mockRunEmbeddedPiAgentOk();
        const res = await getReplyFromConfig(testCase.request, testCase.options, makeCfg(home));
        const text = maybeReplyText(res);
        expect(text, testCase.label).toBe("ok");
        expect(text, testCase.label).not.toMatch(/Thinking level set/i);
        expect(runEmbeddedPiAgentMock, testCase.label).toHaveBeenCalledOnce();
        if (testCase.assertPrompt) {
          const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
          expect(prompt).toContain("Give me the status");
          expect(prompt).not.toContain("/thinking high");
          expect(prompt).not.toContain("/think high");
        }
      }
    });
  });

  it("resolves heartbeat model selection from overrides", async () => {
    await withTempHome(async (home) => {
      const modelCases = [
        {
          expected: { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
          label: "heartbeat-override",
          setup: (cfg: ReturnType<typeof makeCfg>) => {
            cfg.agents = {
              ...cfg.agents,
              defaults: {
                ...cfg.agents?.defaults,
                heartbeat: { model: "anthropic/claude-haiku-4-5-20251001" },
              },
            };
          },
        },
        {
          expected: { model: "gpt-5.4", provider: "openai" },
          label: "stored-override",
          setup: () => undefined,
        },
      ] as const;

      for (const testCase of modelCases) {
        const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
        runEmbeddedPiAgentMock.mockReset();
        mockEmbeddedOkPayload();
        const cfg = makeCfg(home);
        cfg.session = { ...cfg.session, store: join(home, `${testCase.label}.sessions.json`) };
        await writeStoredModelOverride(cfg);
        testCase.setup(cfg);
        await getReplyFromConfig(BASE_MESSAGE, { isHeartbeat: true }, cfg);

        const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
        expect(call?.provider).toBe(testCase.expected.provider);
        expect(call?.model).toBe(testCase.expected.model);
      }
    });
  });

  it("compacts the active main session", async () => {
    await withTempHome(async (home) => {
      const storePath = join(home, "compact-main.sessions.json");
      const cfg = makeCfg(home);
      cfg.session = { ...cfg.session, store: storePath };
      mockSuccessfulCompaction();

      const request = {
        Body: "/compact focus on decisions",
        From: "+1003",
        To: "+2000",
      };

      const res = await getReplyFromConfig(
        {
          ...request,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      const text = maybeReplyText(res);
      expect(text?.startsWith("⚙️ Compacted")).toBe(true);
      expect(getCompactEmbeddedPiSessionMock()).toHaveBeenCalledOnce();
      const store = loadSessionStore(storePath);
      const sessionKey = resolveSessionKey("per-sender", request);
      expect(store[sessionKey]?.compactionCount).toBe(1);
    });
  });

  it("compacts worker sessions via the agent session file", async () => {
    await withTempHome(async (home) => {
      getCompactEmbeddedPiSessionMock().mockReset();
      mockSuccessfulCompaction();
      const cfg = makeCfg(home);
      cfg.session = { ...cfg.session, store: join(home, "compact-worker.sessions.json") };
      const res = await getReplyFromConfig(
        {
          Body: "/compact",
          CommandAuthorized: true,
          From: "+1004",
          SessionKey: "agent:worker1:telegram:12345",
          To: "+2000",
        },
        {},
        cfg,
      );

      const text = maybeReplyText(res);
      expect(text?.startsWith("⚙️ Compacted")).toBe(true);
      expect(getCompactEmbeddedPiSessionMock()).toHaveBeenCalledOnce();
      expect(getCompactEmbeddedPiSessionMock().mock.calls[0]?.[0]?.sessionFile).toContain(
        join("agents", "worker1", "sessions"),
      );
    });
  });

  it("aborts native target sessions and clears queued followups", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      cfg.session = { ...cfg.session, store: join(home, "native-stop.sessions.json") };
      getAbortEmbeddedPiRunMock().mockReset().mockReturnValue(false);
      const storePath = cfg.session?.store;
      if (!storePath) {
        throw new Error("missing session store path");
      }
      const targetSessionKey = "agent:main:telegram:group:123";
      const targetSessionId = "session-target";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [targetSessionKey]: {
            sessionId: targetSessionId,
            updatedAt: Date.now(),
          },
        }),
      );
      const followupRun: FollowupRun = {
        enqueuedAt: Date.now(),
        prompt: "queued",
        run: {
          agentAccountId: "acct",
          agentDir: join(home, "agent"),
          agentId: "main",
          blockReplyBreak: "text_end",
          config: cfg,
          messageProvider: "telegram",
          model: "claude-opus-4-6",
          provider: "anthropic",
          sessionFile: join(home, "session.jsonl"),
          sessionId: targetSessionId,
          sessionKey: targetSessionKey,
          timeoutMs: 10,
          workspaceDir: join(home, "workspace"),
        },
      };
      enqueueFollowupRun(
        targetSessionKey,
        followupRun,
        { cap: 20, debounceMs: 0, dropPolicy: "summarize", mode: "collect" },
        "none",
      );
      expect(getFollowupQueueDepth(targetSessionKey)).toBe(1);

      const res = await getReplyFromConfig(
        {
          Body: "/stop",
          ChatType: "direct",
          CommandAuthorized: true,
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          From: "telegram:111",
          Provider: "telegram",
          SessionKey: "telegram:slash:111",
          Surface: "telegram",
          To: "telegram:111",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(getAbortEmbeddedPiRunMock()).toHaveBeenCalledWith(targetSessionId);
      const store = loadSessionStore(storePath);
      expect(store[targetSessionKey]?.abortedLastRun).toBe(true);
      expect(getFollowupQueueDepth(targetSessionKey)).toBe(0);
    });
  });

  it("applies native model changes to the target session", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      cfg.session = { ...cfg.session, store: join(home, "native-model.sessions.json") };
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockReset();
      const storePath = cfg.session?.store;
      if (!storePath) {
        throw new Error("missing session store path");
      }
      const slashSessionKey = "telegram:slash:111";
      const targetSessionKey = MAIN_SESSION_KEY;

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [targetSessionKey]: {
            sessionId: "session-target",
            updatedAt: Date.now(),
          },
        }),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/model openai/gpt-4.1-mini",
          ChatType: "direct",
          CommandAuthorized: true,
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          From: "telegram:111",
          Provider: "telegram",
          SessionKey: slashSessionKey,
          Surface: "telegram",
          To: "telegram:111",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to openai/gpt-4.1-mini");

      const store = loadSessionStore(storePath);
      expect(store[targetSessionKey]?.providerOverride).toBe("openai");
      expect(store[targetSessionKey]?.modelOverride).toBe("gpt-4.1-mini");
      expect(store[slashSessionKey]).toBeUndefined();

      runEmbeddedPiAgentMock.mockReset();
      runEmbeddedPiAgentMock.mockResolvedValue({
        meta: {
          agentMeta: { model: "m", provider: "p", sessionId: "s" },
          durationMs: 5,
        },
        payloads: [{ text: "ok" }],
      });

      await getReplyFromConfig(
        {
          Body: "hi",
          ChatType: "direct",
          From: "telegram:111",
          Provider: "telegram",
          SessionKey: targetSessionKey,
          Surface: "telegram",
          To: "telegram:111",
        },
        {},
        cfg,
      );

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          model: "gpt-4.1-mini",
          provider: "openai",
        }),
      );
    });
  });

  it("applies native model auth profile overrides to the target session", async () => {
    await withTempHome(async (home) => {
      const cfg = withFullRuntimeReplyConfig({
        ...makeCfg(home),
        session: { store: join(home, "native-model-auth.sessions.json") },
      });
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockReset();
      const storePath = cfg.session?.store;
      if (!storePath) {
        throw new Error("missing session store path");
      }
      const authDir = join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(authDir, { recursive: true });
      await fs.writeFile(
        join(authDir, "auth-profiles.json"),
        JSON.stringify(
          {
            profiles: {
              [TEST_PRIMARY_PROFILE_ID]: {
                access: "oauth-access-token-josh",
                provider: "openai-codex",
                type: "oauth",
              },
              [TEST_SECONDARY_PROFILE_ID]: {
                access: "oauth-access-token",
                provider: "openai-codex",
                type: "oauth",
              },
            },
            version: 1,
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        join(authDir, "auth-state.json"),
        JSON.stringify(
          {
            order: {
              "openai-codex": [TEST_PRIMARY_PROFILE_ID],
            },
            version: 1,
          },
          null,
          2,
        ),
      );

      const slashSessionKey = "telegram:slash:111";
      const targetSessionKey = MAIN_SESSION_KEY;

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [targetSessionKey]: {
            sessionId: "session-target",
            updatedAt: Date.now(),
          },
        }),
      );

      const res = await getReplyFromConfig(
        {
          Body: `/model openai-codex/gpt-5.4@${TEST_SECONDARY_PROFILE_ID}`,
          ChatType: "direct",
          CommandAuthorized: true,
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          From: "telegram:111",
          Provider: "telegram",
          SessionKey: slashSessionKey,
          Surface: "telegram",
          To: "telegram:111",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain(`Auth profile set to ${TEST_SECONDARY_PROFILE_ID}`);

      const store = loadSessionStore(storePath);
      expect(store[targetSessionKey]?.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(store[targetSessionKey]?.authProfileOverrideSource).toBe("user");
      expect(store[slashSessionKey]).toBeUndefined();

      runEmbeddedPiAgentMock.mockReset();
      runEmbeddedPiAgentMock.mockResolvedValue({
        meta: {
          agentMeta: { model: "m", provider: "p", sessionId: "s" },
          durationMs: 5,
        },
        payloads: [{ text: "ok" }],
      });

      await getReplyFromConfig(
        {
          Body: "hi",
          ChatType: "direct",
          From: "telegram:111",
          Provider: "telegram",
          SessionKey: targetSessionKey,
          Surface: "telegram",
          To: "telegram:111",
        },
        {},
        cfg,
      );

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          authProfileId: TEST_SECONDARY_PROFILE_ID,
          authProfileIdSource: "user",
          model: "gpt-5.4",
          provider: "openai-codex",
        }),
      );
    });
  });

  it("handles bare session reset, inline commands, and unauthorized inline status", async () => {
    await withTempHome(async (home) => {
      await runGreetingPromptForBareNewOrReset({ body: "/new", getReplyFromConfig, home });
      await expectResetBlockedForNonOwner({ home });
      await expectInlineCommandHandledAndStripped({
        blockReplyContains: "Identity",
        body: "please /whoami now",
        getReplyFromConfig,
        home,
        requestOverrides: { SenderId: "12345" },
        stripToken: "/whoami",
      });
      const inlineRunEmbeddedPiAgentMock = mockEmbeddedOk();
      const res = await runInlineUnauthorizedCommand({
        command: "/status",
        home,
      });
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(inlineRunEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = inlineRunEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
      expect(prompt).toContain("/status");
    });
  });
});
