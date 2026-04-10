import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-runtime";
import { createSlackWebClient } from "./client.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
};

export async function probeSlack(token: string, timeoutMs = 2500): Promise<SlackProbe> {
  const client = createSlackWebClient(token);
  const start = Date.now();
  try {
    const result = await withTimeout(client.auth.test(), timeoutMs);
    if (!result.ok) {
      return {
        elapsedMs: Date.now() - start,
        error: result.error ?? "unknown",
        ok: false,
        status: 200,
      };
    }
    return {
      bot: { id: result.user_id, name: result.user },
      elapsedMs: Date.now() - start,
      ok: true,
      status: 200,
      team: { id: result.team_id, name: result.team },
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    const status =
      typeof (error as { status?: number }).status === "number"
        ? (error as { status?: number }).status
        : null;
    return {
      elapsedMs: Date.now() - start,
      error: message,
      ok: false,
      status,
    };
  }
}
