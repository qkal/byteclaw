import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { collectIssuesForEnabledAccounts } from "openclaw/plugin-sdk/status-helpers";
import { asRecord } from "./monitor-normalize.js";

interface BlueBubblesAccountStatus {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  running?: unknown;
  baseUrl?: unknown;
  lastError?: unknown;
  probe?: unknown;
}

interface BlueBubblesProbeResult {
  ok?: boolean;
  status?: number | null;
  error?: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBlueBubblesAccountStatus(
  value: ChannelAccountSnapshot,
): BlueBubblesAccountStatus | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    accountId: record.accountId,
    baseUrl: record.baseUrl,
    configured: record.configured,
    enabled: record.enabled,
    lastError: record.lastError,
    probe: record.probe,
    running: record.running,
  };
}

function readBlueBubblesProbeResult(value: unknown): BlueBubblesProbeResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    error: asString(record.error) ?? null,
    ok: typeof record.ok === "boolean" ? record.ok : undefined,
    status: typeof record.status === "number" ? record.status : null,
  };
}

export function collectBlueBubblesStatusIssues(accounts: ChannelAccountSnapshot[]) {
  return collectIssuesForEnabledAccounts({
    accounts,
    collectIssues: ({ account, accountId, issues }) => {
      const configured = account.configured === true;
      const running = account.running === true;
      const lastError = asString(account.lastError);
      const probe = readBlueBubblesProbeResult(account.probe);

      if (!configured) {
        issues.push({
          accountId,
          channel: "bluebubbles",
          fix: "Run: openclaw channels add bluebubbles --http-url <server-url> --password <password>",
          kind: "config",
          message: "Not configured (missing serverUrl or password).",
        });
        return;
      }

      if (probe && probe.ok === false) {
        const errorDetail = probe.error
          ? `: ${probe.error}`
          : (probe.status
            ? ` (HTTP ${probe.status})`
            : "");
        issues.push({
          accountId,
          channel: "bluebubbles",
          fix: "Check that the BlueBubbles server is running and accessible. Verify serverUrl and password in your config.",
          kind: "runtime",
          message: `BlueBubbles server unreachable${errorDetail}`,
        });
      }

      if (running && lastError) {
        issues.push({
          accountId,
          channel: "bluebubbles",
          fix: "Check gateway logs for details. If the webhook is failing, verify the webhook URL is configured in BlueBubbles server settings.",
          kind: "runtime",
          message: `Channel error: ${lastError}`,
        });
      }
    },
    readAccount: readBlueBubblesAccountStatus,
  });
}
