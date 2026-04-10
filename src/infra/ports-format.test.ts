import { describe, expect, it } from "vitest";
import {
  buildPortHints,
  classifyPortListener,
  formatPortDiagnostics,
  formatPortListener,
  isDualStackLoopbackGatewayListeners,
} from "./ports-format.js";

describe("ports-format", () => {
  it.each([
    [{ commandLine: "ssh -N -L 18789:127.0.0.1:18789 user@host" }, "ssh"],
    [{ command: "ssh" }, "ssh"],
    [{ commandLine: "node /Users/me/Projects/openclaw/dist/entry.js gateway" }, "gateway"],
    [{ commandLine: "python -m http.server 18789" }, "unknown"],
  ] as const)("classifies port listener %j", (listener, expected) => {
    expect(classifyPortListener(listener, 18_789)).toBe(expected);
  });

  it("builds ordered hints for mixed listener kinds and multiplicity", () => {
    expect(
      buildPortHints(
        [
          { commandLine: "node dist/index.js openclaw gateway" },
          { commandLine: "ssh -N -L 18789:127.0.0.1:18789" },
          { commandLine: "python -m http.server 18789" },
        ],
        18_789,
      ),
    ).toEqual([
      expect.stringContaining("Gateway already running locally."),
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
      "Another process is listening on this port.",
      expect.stringContaining("Multiple listeners detected"),
    ]);
    expect(buildPortHints([], 18_789)).toEqual([]);
  });

  it("treats single-process loopback dual-stack gateway listeners as benign", () => {
    const listeners = [
      { address: "127.0.0.1:18789", commandLine: "openclaw-gateway", pid: 4242 },
      { address: "[::1]:18789", commandLine: "openclaw-gateway", pid: 4242 },
    ];
    expect(isDualStackLoopbackGatewayListeners(listeners, 18_789)).toBe(true);
    expect(buildPortHints(listeners, 18_789)).toEqual([
      expect.stringContaining("Gateway already running locally."),
    ]);
  });

  it.each([
    [
      { address: "::1", commandLine: "ssh -N", pid: 123, user: "alice" },
      "pid 123 alice: ssh -N (::1)",
    ],
    [{ address: "127.0.0.1:18789", command: "ssh" }, "pid ?: ssh (127.0.0.1:18789)"],
    [{}, "pid ?: unknown"],
  ] as const)("formats port listener %j", (listener, expected) => {
    expect(formatPortListener(listener)).toBe(expected);
  });

  it("formats free and busy port diagnostics", () => {
    expect(
      formatPortDiagnostics({
        hints: [],
        listeners: [],
        port: 18_789,
        status: "free",
      }),
    ).toEqual(["Port 18789 is free."]);

    const lines = formatPortDiagnostics({
      hints: buildPortHints([{ commandLine: "ssh -N -L 18789:127.0.0.1:18789", pid: 123 }], 18_789),
      listeners: [{ commandLine: "ssh -N -L 18789:127.0.0.1:18789", pid: 123, user: "alice" }],
      port: 18_789,
      status: "busy",
    });
    expect(lines[0]).toContain("Port 18789 is already in use");
    expect(lines).toContain("- pid 123 alice: ssh -N -L 18789:127.0.0.1:18789");
    expect(lines.some((line) => line.includes("SSH tunnel"))).toBe(true);
  });
});
