import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverAgentCommandResult } from "../agents/command/delivery.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  getChannelPlugin: vi.fn(() => ({})),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15551234567" })),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  getLoadedChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/targets.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/outbound/targets.js")>(
    "../infra/outbound/targets.js",
  );
  return {
    ...actual,
    resolveOutboundTarget: mocks.resolveOutboundTarget,
  };
});

describe("deliverAgentCommandResult", () => {
  function createRuntime(): RuntimeEnv {
    return {
      error: vi.fn(),
      log: vi.fn(),
    } as unknown as RuntimeEnv;
  }

  function createResult(text = "hi") {
    return {
      meta: { durationMs: 1 },
      payloads: [{ text }],
    };
  }

  async function runDelivery(params: {
    opts: Record<string, unknown>;
    outboundSession?: { key?: string; agentId?: string };
    sessionEntry?: SessionEntry;
    runtime?: RuntimeEnv;
    resultText?: string;
    payloads?: ReplyPayload[];
  }) {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = params.runtime ?? createRuntime();
    const result = params.payloads
      ? {
          meta: { durationMs: 1 },
          payloads: params.payloads,
        }
      : createResult(params.resultText);

    await deliverAgentCommandResult({
      cfg,
      deps,
      opts: params.opts as never,
      outboundSession: params.outboundSession,
      payloads: result.payloads,
      result,
      runtime,
      sessionEntry: params.sessionEntry,
    });

    return { runtime };
  }

  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockClear();
    mocks.resolveOutboundTarget.mockClear();
  });

  it("prefers explicit accountId for outbound delivery", async () => {
    await runDelivery({
      opts: {
        accountId: "kev",
        channel: "whatsapp",
        deliver: true,
        message: "hello",
        to: "+15551234567",
      },
      sessionEntry: {
        lastAccountId: "default",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "kev" }),
    );
  });

  it("falls back to session accountId for implicit delivery", async () => {
    await runDelivery({
      opts: {
        channel: "whatsapp",
        deliver: true,
        message: "hello",
      },
      sessionEntry: {
        lastAccountId: "legacy",
        lastChannel: "whatsapp",
      } as SessionEntry,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "legacy" }),
    );
  });

  it("does not infer accountId for explicit delivery targets", async () => {
    await runDelivery({
      opts: {
        channel: "whatsapp",
        deliver: true,
        deliveryTargetMode: "explicit",
        message: "hello",
        to: "+15551234567",
      },
      sessionEntry: {
        lastAccountId: "legacy",
      } as SessionEntry,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined, mode: "explicit" }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    );
  });

  it("skips session accountId when channel differs", async () => {
    await runDelivery({
      opts: {
        channel: "whatsapp",
        deliver: true,
        message: "hello",
      },
      sessionEntry: {
        lastAccountId: "legacy",
        lastChannel: "telegram",
      } as SessionEntry,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined, channel: "whatsapp" }),
    );
  });

  it("uses session last channel when none is provided", async () => {
    await runDelivery({
      opts: {
        deliver: true,
        message: "hello",
      },
      sessionEntry: {
        lastChannel: "telegram",
        lastTo: "123",
      } as SessionEntry,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", to: "123" }),
    );
  });

  it("uses reply overrides for delivery routing", async () => {
    await runDelivery({
      opts: {
        deliver: true,
        message: "hello",
        replyAccountId: "ops",
        replyChannel: "slack",
        replyTo: "#reports",
        to: "+15551234567",
      },
      sessionEntry: {
        lastAccountId: "legacy",
        lastChannel: "telegram",
        lastTo: "123",
      } as SessionEntry,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "ops", channel: "slack", to: "#reports" }),
    );
  });

  it("uses runContext turn source over stale session last route", async () => {
    await runDelivery({
      opts: {
        deliver: true,
        message: "hello",
        runContext: {
          accountId: "work",
          currentChannelId: "+15559876543",
          messageChannel: "whatsapp",
        },
      },
      sessionEntry: {
        lastAccountId: "wrong",
        lastChannel: "slack",
        lastTo: "U_WRONG",
      } as SessionEntry,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "work", channel: "whatsapp", to: "+15559876543" }),
    );
  });

  it("does not reuse session lastTo when runContext source omits currentChannelId", async () => {
    await runDelivery({
      opts: {
        deliver: true,
        message: "hello",
        runContext: {
          messageChannel: "whatsapp",
        },
      },
      sessionEntry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
      } as SessionEntry,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", to: undefined }),
    );
  });

  it("uses caller-provided outbound session context when opts.sessionKey is absent", async () => {
    await runDelivery({
      opts: {
        channel: "whatsapp",
        deliver: true,
        message: "hello",
        to: "+15551234567",
      },
      outboundSession: {
        agentId: "exec",
        key: "agent:exec:hook:gmail:thread-1",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "exec",
          key: "agent:exec:hook:gmail:thread-1",
        }),
      }),
    );
  });

  it("prefixes nested agent outputs with context", async () => {
    const runtime = createRuntime();
    await runDelivery({
      opts: {
        deliver: false,
        lane: "nested",
        message: "hello",
        messageChannel: "webchat",
        runId: "run-announce",
        sessionKey: "agent:main:main",
      },
      resultText: "ANNOUNCE_SKIP",
      runtime,
      sessionEntry: undefined,
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const line = String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(line).toContain("[agent:nested]");
    expect(line).toContain("session=agent:main:main");
    expect(line).toContain("run=run-announce");
    expect(line).toContain("channel=webchat");
    expect(line).toContain("ANNOUNCE_SKIP");
  });

  it("preserves audioAsVoice in JSON output envelopes", async () => {
    const runtime = createRuntime();
    await runDelivery({
      opts: {
        deliver: false,
        json: true,
        message: "hello",
      },
      payloads: [{ audioAsVoice: true, mediaUrl: "file:///tmp/clip.mp3", text: "voice caption" }],
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])),
    ).toEqual({
      meta: { durationMs: 1 },
      payloads: [
        {
          audioAsVoice: true,
          mediaUrl: "file:///tmp/clip.mp3",
          mediaUrls: ["file:///tmp/clip.mp3"],
          text: "voice caption",
        },
      ],
    });
  });
});
