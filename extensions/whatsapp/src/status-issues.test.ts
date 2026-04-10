import { describe, expect, it } from "vitest";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

describe("collectWhatsAppStatusIssues", () => {
  it("reports unlinked enabled accounts", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: false,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        accountId: "default",
        channel: "whatsapp",
        kind: "auth",
      }),
    ]);
  });

  it("reports linked but disconnected runtime state", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "work",
        connected: false,
        enabled: true,
        lastError: "socket closed",
        linked: true,
        reconnectAttempts: 2,
        running: true,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        accountId: "work",
        channel: "whatsapp",
        kind: "runtime",
        message: "Linked but disconnected (reconnectAttempts=2): socket closed",
      }),
    ]);
  });

  it("reports linked but stale runtime state even while connected", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        connected: true,
        enabled: true,
        healthState: "stale",
        lastInboundAt: Date.now() - 2 * 60_000,
        linked: true,
        running: true,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        accountId: "default",
        channel: "whatsapp",
        kind: "runtime",
        message: expect.stringContaining("Linked but stale"),
      }),
    ]);
  });
});
