import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlueBubblesPairingText } from "./pairing.js";
import type { OpenClawConfig } from "./runtime-api.js";

const sendMessageBlueBubblesMock = vi.fn();
const bluebubblesPairingText = createBlueBubblesPairingText(sendMessageBlueBubblesMock);

describe("bluebubblesPlugin.pairing.notifyApproval", () => {
  beforeEach(() => {
    sendMessageBlueBubblesMock.mockReset();
    sendMessageBlueBubblesMock.mockResolvedValue({ messageId: "bb-pairing" });
  });

  it("preserves accountId when sending pairing approvals", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          accounts: {
            work: {
              password: "test-password",
              serverUrl: "http://localhost:1234",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(bluebubblesPairingText.normalizeAllowEntry("  bluebubbles:+15551234567  ")).toBe(
      "+15551234567",
    );

    await bluebubblesPairingText.notify({
      accountId: "work",
      cfg,
      id: "+15551234567",
      message: bluebubblesPairingText.message,
    });

    expect(sendMessageBlueBubblesMock).toHaveBeenCalledWith(
      "+15551234567",
      expect.any(String),
      expect.objectContaining({
        accountId: "work",
        cfg,
      }),
    );
  });
});
