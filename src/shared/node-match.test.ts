import { describe, expect, it } from "vitest";
import { normalizeNodeKey, resolveNodeIdFromCandidates, resolveNodeMatches } from "./node-match.js";

describe("shared/node-match", () => {
  it("normalizes node keys by lowercasing and collapsing separators", () => {
    expect(normalizeNodeKey(" Mac Studio! ")).toBe("mac-studio");
    expect(normalizeNodeKey("---PI__Node---")).toBe("pi-node");
    expect(normalizeNodeKey("###")).toBe("");
  });

  it("matches candidates by node id, remote ip, normalized name, and long prefix", () => {
    const nodes = [
      { displayName: "Mac Studio", nodeId: "mac-abcdef", remoteIp: "100.0.0.1" },
      { displayName: "Raspberry Pi", nodeId: "pi-456789", remoteIp: "100.0.0.2" },
    ];

    expect(resolveNodeMatches(nodes, "mac-abcdef")).toEqual([nodes[0]]);
    expect(resolveNodeMatches(nodes, "100.0.0.2")).toEqual([nodes[1]]);
    expect(resolveNodeMatches(nodes, "mac studio")).toEqual([nodes[0]]);
    expect(resolveNodeMatches(nodes, "  Mac---Studio!! ")).toEqual([nodes[0]]);
    expect(resolveNodeMatches(nodes, "pi-456")).toEqual([nodes[1]]);
    expect(resolveNodeMatches(nodes, "pi")).toEqual([]);
    expect(resolveNodeMatches(nodes, "   ")).toEqual([]);
  });

  it("resolves unique matches and prefers a unique connected node", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { connected: false, displayName: "iPhone", nodeId: "ios-old" },
          { connected: true, displayName: "iPhone", nodeId: "ios-live" },
        ],
        "iphone",
      ),
    ).toBe("ios-live");
  });

  it("prefers the strongest match type before client heuristics", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { connected: false, displayName: "Other Node", nodeId: "mac-studio" },
          { connected: true, displayName: "Mac Studio", nodeId: "mac-2" },
        ],
        "mac-studio",
      ),
    ).toBe("mac-studio");
  });

  it("prefers a unique current OpenClaw client over a legacy clawdbot client", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          {
            clientId: "clawdbot-macos",
            connected: false,
            displayName: "Peter’s Mac Studio",
            nodeId: "legacy-mac",
          },
          {
            clientId: "openclaw-macos",
            connected: false,
            displayName: "Peter’s Mac Studio",
            nodeId: "current-mac",
          },
        ],
        "Peter's Mac Studio",
      ),
    ).toBe("current-mac");
  });

  it("falls back to raw ambiguous matches when none of them are connected", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { connected: false, displayName: "iPhone", nodeId: "ios-a" },
          { connected: false, displayName: "iPhone", nodeId: "ios-b" },
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*node=ios-a.*node=ios-b/);
  });

  it("throws clear unknown and ambiguous node errors", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { displayName: "Mac Studio", nodeId: "mac-123", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456" },
        ],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: Mac Studio, pi-456/);

    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { connected: true, displayName: "iPhone", nodeId: "ios-a" },
          { connected: true, displayName: "iPhone", nodeId: "ios-b" },
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*node=ios-a.*node=ios-b/);

    expect(() => resolveNodeIdFromCandidates([], "")).toThrow(/node required/);
  });

  it("prints client ids in ambiguous-node errors when available", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          {
            clientId: "clawdbot-macos",
            connected: true,
            displayName: "Peter’s Mac Studio",
            nodeId: "legacy-mac",
          },
          {
            clientId: "openclaw-macos",
            connected: true,
            displayName: "Peter’s Mac Studio",
            nodeId: "other-mac",
          },
          {
            clientId: "openclaw-macos",
            connected: true,
            displayName: "Peter’s Mac Studio",
            nodeId: "third-mac",
          },
        ],
        "Peter's Mac Studio",
      ),
    ).toThrow(
      /ambiguous node: Peter's Mac Studio.*node=other-mac.*client=openclaw-macos.*node=third-mac.*client=openclaw-macos/,
    );
  });

  it("lists remote ips in unknown-node errors when display names are missing", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [{ nodeId: "mac-123", remoteIp: "100.0.0.1" }, { nodeId: "pi-456" }],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: 100.0.0.1, pi-456/);
  });
});
