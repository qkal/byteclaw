import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearInternalHooks, registerInternalHook } from "../../hooks/internal-hooks.js";
import type { FinalizedMsgContext } from "../templating.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";

function makeCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "<media:audio>",
    BodyForAgent: "[Audio] Transcript: hello",
    BodyForCommands: "<media:audio>",
    From: "telegram:user:1",
    GroupChannel: "ops",
    MessageSid: "msg-1",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:chat-1",
    Provider: "telegram",
    SessionKey: "agent:main:telegram:chat-1",
    Surface: "telegram",
    Timestamp: 1_710_000_000,
    To: "telegram:chat-1",
    Transcript: "hello",
    ...overrides,
  } as FinalizedMsgContext;
}

describe("emitPreAgentMessageHooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  it("emits transcribed and preprocessed events when transcript exists", async () => {
    const actions: string[] = [];
    registerInternalHook("message", (event) => {
      actions.push(event.action);
    });

    emitPreAgentMessageHooks({
      cfg: {} as OpenClawConfig,
      ctx: makeCtx(),
      isFastTestEnv: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(actions).toEqual(["transcribed", "preprocessed"]);
  });

  it("emits only preprocessed when transcript is missing", async () => {
    const actions: string[] = [];
    registerInternalHook("message", (event) => {
      actions.push(event.action);
    });

    emitPreAgentMessageHooks({
      cfg: {} as OpenClawConfig,
      ctx: makeCtx({ Transcript: undefined }),
      isFastTestEnv: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(actions).toEqual(["preprocessed"]);
  });

  it("skips hook emission in fast-test mode", async () => {
    const handler = vi.fn();
    registerInternalHook("message", handler);

    emitPreAgentMessageHooks({
      cfg: {} as OpenClawConfig,
      ctx: makeCtx(),
      isFastTestEnv: true,
    });
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });

  it("skips hook emission without session key", async () => {
    const handler = vi.fn();
    registerInternalHook("message", handler);

    emitPreAgentMessageHooks({
      cfg: {} as OpenClawConfig,
      ctx: makeCtx({ SessionKey: " " }),
      isFastTestEnv: false,
    });
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });
});
