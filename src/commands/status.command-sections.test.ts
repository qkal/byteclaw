import { describe, expect, it } from "vitest";
import type { HealthSummary } from "./health.js";
import {
  buildStatusFooterLines,
  buildStatusHealthRows,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  statusHealthColumns,
} from "./status.command-sections.ts";

describe("status.command-sections", () => {
  it("formats security audit lines with finding caps and follow-up commands", () => {
    const lines = buildStatusSecurityAuditLines({
      formatCliCommand: (value) => `cmd:${value}`,
      securityAudit: {
        findings: [
          {
            detail: "warn detail",
            severity: "warn",
            title: "Warn first",
          },
          {
            detail: "critical\ndetail",
            remediation: "fix it",
            severity: "critical",
            title: "Critical first",
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            detail: `detail ${index + 2}`,
            severity: "warn" as const,
            title: `Warn ${index + 2}`,
          })),
        ],
        summary: { critical: 1, info: 2, warn: 6 },
      },
      shortenText: (value) => value,
      theme: {
        error: (value) => `error(${value})`,
        muted: (value) => `muted(${value})`,
        warn: (value) => `warn(${value})`,
      },
    });

    expect(lines[0]).toBe("muted(Summary: error(1 critical) · warn(6 warn) · muted(2 info))");
    expect(lines).toContain("  error(CRITICAL) Critical first");
    expect(lines).toContain("    critical detail");
    expect(lines).toContain("    muted(Fix: fix it)");
    expect(lines).toContain("muted(… +1 more)");
    expect(lines.at(-2)).toBe("muted(Full report: cmd:openclaw security audit)");
    expect(lines.at(-1)).toBe("muted(Deep probe: cmd:openclaw security audit --deep)");
  });

  it("builds verbose sessions rows and empty fallback rows", () => {
    const verboseRows = buildStatusSessionsRows({
      formatPromptCacheCompact: () => "cache ok",
      formatTimeAgo: (value) => `${value}ms`,
      formatTokensCompact: () => "12k",
      muted: (value) => `muted(${value})`,
      recent: [
        {
          age: 5_000,
          contextTokens: null,
          flags: [],
          key: "session-key-1234567890",
          kind: "direct",
          model: "gpt-5.4",
          percentUsed: null,
          remainingTokens: null,
          totalTokens: null,
          totalTokensFresh: false,
          updatedAt: 1,
        },
      ],
      shortenText: (value) => value.slice(0, 8),
      verbose: true,
    });

    expect(verboseRows).toEqual([
      {
        Age: "5000ms",
        Cache: "cache ok",
        Key: "session-",
        Kind: "direct",
        Model: "gpt-5.4",
        Tokens: "12k",
      },
    ]);

    const emptyRows = buildStatusSessionsRows({
      formatPromptCacheCompact: () => null,
      formatTimeAgo: () => "",
      formatTokensCompact: () => "",
      muted: (value) => `muted(${value})`,
      recent: [],
      shortenText: (value) => value,
      verbose: true,
    });

    expect(emptyRows).toEqual([
      {
        Age: "",
        Cache: "",
        Key: "muted(no sessions yet)",
        Kind: "",
        Model: "",
        Tokens: "",
      },
    ]);
  });

  it("maps health channel detail lines into status rows", () => {
    const rows = buildStatusHealthRows({
      formatHealthChannelLines: () => [
        "Telegram: OK · ready",
        "Slack: failed · auth",
        "Discord: not configured",
        "Matrix: linked",
        "Signal: not linked",
      ],
      health: { durationMs: 42 } as HealthSummary,
      muted: (value) => `muted(${value})`,
      ok: (value) => `ok(${value})`,
      warn: (value) => `warn(${value})`,
    });

    expect(rows).toEqual([
      { Detail: "42ms", Item: "Gateway", Status: "ok(reachable)" },
      { Detail: "OK · ready", Item: "Telegram", Status: "ok(OK)" },
      { Detail: "failed · auth", Item: "Slack", Status: "warn(WARN)" },
      { Detail: "not configured", Item: "Discord", Status: "muted(OFF)" },
      { Detail: "linked", Item: "Matrix", Status: "ok(LINKED)" },
      { Detail: "not linked", Item: "Signal", Status: "warn(UNLINKED)" },
    ]);
  });

  it("builds footer lines from update and reachability state", () => {
    expect(
      buildStatusFooterLines({
        formatCliCommand: (value) => `cmd:${value}`,
        gatewayReachable: false,
        nodeOnlyGateway: null,
        updateHint: "upgrade ready",
        warn: (value) => `warn(${value})`,
      }),
    ).toEqual([
      "FAQ: https://docs.openclaw.ai/faq",
      "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
      "",
      "warn(upgrade ready)",
      "Next steps:",
      "  Need to share?      cmd:openclaw status --all",
      "  Need to debug live? cmd:openclaw logs --follow",
      "  Fix reachability first: cmd:openclaw gateway probe",
    ]);
  });

  it("builds plugin compatibility lines and pairing recovery guidance", () => {
    expect(
      buildStatusPluginCompatibilityLines({
        formatNotice: (notice) => String(notice.message),
        limit: 2,
        muted: (value) => `muted(${value})`,
        notices: [
          { message: "legacy", severity: "warn" as const },
          { message: "heads-up", severity: "info" as const },
          { message: "extra", severity: "warn" as const },
        ],
        warn: (value) => `warn(${value})`,
      }),
    ).toEqual(["  warn(WARN) legacy", "  muted(INFO) heads-up", "muted(  … +1 more)"]);

    expect(
      buildStatusPairingRecoveryLines({
        formatCliCommand: (value) => `cmd:${value}`,
        muted: (value) => `muted(${value})`,
        pairingRecovery: { requestId: "req-123" },
        warn: (value) => `warn(${value})`,
      }),
    ).toEqual([
      "warn(Gateway pairing approval required.)",
      "muted(Recovery: cmd:openclaw devices approve req-123)",
      "muted(Fallback: cmd:openclaw devices approve --latest)",
      "muted(Inspect: cmd:openclaw devices list)",
    ]);
  });

  it("builds system event rows and health columns", () => {
    expect(
      buildStatusSystemEventsRows({
        limit: 2,
        queuedSystemEvents: ["one", "two", "three"],
      }),
    ).toEqual([{ Event: "one" }, { Event: "two" }]);
    expect(
      buildStatusSystemEventsTrailer({
        limit: 2,
        muted: (value) => `muted(${value})`,
        queuedSystemEvents: ["one", "two", "three"],
      }),
    ).toBe("muted(… +1 more)");
    expect(statusHealthColumns).toEqual([
      { header: "Item", key: "Item", minWidth: 10 },
      { header: "Status", key: "Status", minWidth: 8 },
      { flex: true, header: "Detail", key: "Detail", minWidth: 28 },
    ]);
  });
});
