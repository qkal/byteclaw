import { describe, expect, it } from "vitest";
import { buildStatusChannelsTableRows } from "./channels-table.js";

describe("buildStatusChannelsTableRows", () => {
  const ok = (text: string) => `[ok:${text}]`;
  const warn = (text: string) => `[warn:${text}]`;
  const muted = (text: string) => `[muted:${text}]`;
  const accentDim = (text: string) => `[setup:${text}]`;

  it("overlays gateway issues and preserves off rows", () => {
    expect(
      buildStatusChannelsTableRows({
        accentDim,
        channelIssues: [
          { channel: "signal", message: "signal-cli unreachable from gateway runtime" },
          { channel: "discord", message: "should not override off" },
        ],
        formatIssueMessage: (message) => message.slice(0, 20),
        muted,
        ok,
        rows: [
          {
            detail: "configured",
            enabled: true,
            id: "signal",
            label: "Signal",
            state: "ok",
          },
          {
            detail: "disabled",
            enabled: false,
            id: "discord",
            label: "Discord",
            state: "off",
          },
        ],
        warn,
      }),
    ).toEqual([
      {
        Channel: "Signal",
        Detail: "configured · [warn:gateway: signal-cli unreachab]",
        Enabled: "[ok:ON]",
        State: "[warn:WARN]",
      },
      {
        Channel: "Discord",
        Detail: "disabled · [warn:gateway: should not override ]",
        Enabled: "[muted:OFF]",
        State: "[muted:OFF]",
      },
    ]);
  });
});
