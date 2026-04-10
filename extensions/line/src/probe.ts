import { messagingApi } from "@line/bot-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-runtime";
import type { LineProbeResult } from "./types.js";

export async function probeLineBot(
  channelAccessToken: string,
  timeoutMs = 5000,
): Promise<LineProbeResult> {
  if (!channelAccessToken?.trim()) {
    return { error: "Channel access token not configured", ok: false };
  }

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: channelAccessToken.trim(),
  });

  try {
    const profile = await withTimeout(client.getBotInfo(), timeoutMs);

    return {
      bot: {
        basicId: profile.basicId,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl,
        userId: profile.userId,
      },
      ok: true,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    return { error: message, ok: false };
  }
}
