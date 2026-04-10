import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendProactive } from "./proactive.js";

const apiMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  sendProactiveC2CMessage: vi.fn(),
}));

vi.mock("./api.js", () => ({
  getAccessToken: apiMocks.getAccessToken,
  sendC2CImageMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendGroupImageMessage: vi.fn(),
  sendProactiveC2CMessage: apiMocks.sendProactiveC2CMessage,
  sendProactiveGroupMessage: vi.fn(),
}));

describe("qqbot proactive sends", () => {
  beforeEach(() => {
    apiMocks.getAccessToken.mockReset();
    apiMocks.sendProactiveC2CMessage.mockReset();
  });

  it("uses configured defaultAccount when accountId is omitted", async () => {
    apiMocks.getAccessToken.mockResolvedValue("access-token");
    apiMocks.sendProactiveC2CMessage.mockResolvedValue({
      id: "msg-1",
      timestamp: 123,
    });

    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              appId: "654321",
              clientSecret: "secret-value",
            },
          },
          defaultAccount: "bot2",
        },
      },
    } as OpenClawConfig;

    const result = await sendProactive(
      {
        text: "hello",
        to: "openid-1",
      },
      cfg,
    );

    expect(apiMocks.getAccessToken).toHaveBeenCalledWith("654321", "secret-value");
    expect(apiMocks.sendProactiveC2CMessage).toHaveBeenCalledWith(
      "654321",
      "access-token",
      "openid-1",
      "hello",
    );
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-1");
  });
});
