import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recordChannelActivityMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ channels: { discord: {} } })));

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../../../src/infra/channel-activity.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/infra/channel-activity.js")>(
    "../../../src/infra/channel-activity.js",
  );
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivityMock(...args),
  };
});

let sendWebhookMessageDiscord: typeof import("./send.outbound.js").sendWebhookMessageDiscord;

describe("sendWebhookMessageDiscord activity", () => {
  beforeAll(async () => {
    ({ sendWebhookMessageDiscord } = await import("./send.outbound.js"));
  });

  beforeEach(() => {
    recordChannelActivityMock.mockClear();
    loadConfigMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ channel_id: "thread-1", id: "msg-1" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records outbound channel activity for webhook sends", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
        },
      },
    };
    const result = await sendWebhookMessageDiscord("hello world", {
      accountId: "runtime",
      cfg,
      threadId: "thread-1",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    expect(result).toEqual({
      channelId: "thread-1",
      messageId: "msg-1",
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      accountId: "runtime",
      channel: "discord",
      direction: "outbound",
    });
    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
