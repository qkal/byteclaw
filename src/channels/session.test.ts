import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

const recordSessionMetaFromInboundMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));
const updateLastRouteMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));

vi.mock("../config/sessions/inbound.runtime.js", () => ({
  recordSessionMetaFromInbound: (args: unknown) => recordSessionMetaFromInboundMock(args),
  updateLastRoute: (args: unknown) => updateLastRouteMock(args),
}));

type SessionModule = typeof import("./session.js");

let recordInboundSession: SessionModule["recordInboundSession"];

describe("recordInboundSession", () => {
  const ctx: MsgContext = {
    From: "demo-channel:1234",
    OriginatingTo: "demo-channel:1234",
    Provider: "demo-channel",
    SessionKey: "agent:main:demo-channel:1234:thread:42",
  };

  beforeAll(async () => {
    ({ recordInboundSession } = await import("./session.js"));
  });

  beforeEach(() => {
    recordSessionMetaFromInboundMock.mockClear();
    updateLastRouteMock.mockClear();
  });

  it("does not pass ctx when updating a different session key", async () => {
    await recordInboundSession({
      ctx,
      onRecordError: vi.fn(),
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      storePath: "/tmp/openclaw-session-store.json",
      updateLastRoute: {
        channel: "demo-channel",
        sessionKey: "agent:main:main",
        to: "demo-channel:1234",
      },
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: undefined,
        deliveryContext: expect.objectContaining({
          channel: "demo-channel",
          to: "demo-channel:1234",
        }),
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("passes ctx when updating the same session key", async () => {
    await recordInboundSession({
      ctx,
      onRecordError: vi.fn(),
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      storePath: "/tmp/openclaw-session-store.json",
      updateLastRoute: {
        channel: "demo-channel",
        sessionKey: "agent:main:demo-channel:1234:thread:42",
        to: "demo-channel:1234",
      },
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx,
        deliveryContext: expect.objectContaining({
          channel: "demo-channel",
          to: "demo-channel:1234",
        }),
        sessionKey: "agent:main:demo-channel:1234:thread:42",
      }),
    );
  });

  it("normalizes mixed-case session keys before recording and route updates", async () => {
    await recordInboundSession({
      ctx,
      onRecordError: vi.fn(),
      sessionKey: "Agent:Main:Demo-Channel:1234:Thread:42",
      storePath: "/tmp/openclaw-session-store.json",
      updateLastRoute: {
        channel: "demo-channel",
        sessionKey: "agent:main:demo-channel:1234:thread:42",
        to: "demo-channel:1234",
      },
    });

    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:demo-channel:1234:thread:42",
      }),
    );
    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx,
        sessionKey: "agent:main:demo-channel:1234:thread:42",
      }),
    );
  });

  it("skips last-route updates when main DM owner pin mismatches sender", async () => {
    const onSkip = vi.fn();

    await recordInboundSession({
      ctx,
      onRecordError: vi.fn(),
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      storePath: "/tmp/openclaw-session-store.json",
      updateLastRoute: {
        channel: "demo-channel",
        mainDmOwnerPin: {
          onSkip,
          ownerRecipient: "1234",
          senderRecipient: "9999",
        },
        sessionKey: "agent:main:main",
        to: "demo-channel:1234",
      },
    });

    expect(updateLastRouteMock).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({
      ownerRecipient: "1234",
      senderRecipient: "9999",
    });
  });
});
