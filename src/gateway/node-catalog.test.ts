import { describe, expect, it } from "vitest";
import {
  createKnownNodeCatalog,
  getKnownNode,
  getKnownNodeEntry,
  listKnownNodes,
} from "./node-catalog.js";

describe("gateway/node-catalog", () => {
  it("filters paired nodes by active node token instead of sticky historical roles", () => {
    const catalog = createKnownNodeCatalog({
      connectedNodes: [],
      pairedDevices: [
        {
          approvedAtMs: 1,
          clientId: "clawdbot-macos",
          createdAtMs: 1,
          deviceId: "legacy-mac",
          displayName: "Peter's Mac Studio",
          publicKey: "legacy-public-key",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              createdAtMs: 1,
              revokedAtMs: 2,
              role: "node",
              scopes: [],
              token: "legacy-token",
            },
          },
        },
        {
          approvedAtMs: 1,
          clientId: "openclaw-macos",
          createdAtMs: 1,
          deviceId: "current-mac",
          displayName: "Peter's Mac Studio",
          publicKey: "current-public-key",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              createdAtMs: 1,
              role: "node",
              scopes: [],
              token: "current-token",
            },
          },
        },
      ],
      pairedNodes: [],
    });

    expect(listKnownNodes(catalog).map((node) => node.nodeId)).toEqual(["current-mac"]);
  });

  it("builds one merged node view for paired and live state", () => {
    const connectedAtMs = 123;
    const catalog = createKnownNodeCatalog({
      connectedNodes: [
        {
          caps: ["camera", "screen"],
          client: {} as never,
          clientId: "openclaw-macos",
          clientMode: "node",
          commands: ["screen.snapshot", "system.run"],
          connId: "conn-1",
          connectedAtMs,
          displayName: "Mac",
          nodeId: "mac-1",
          pathEnv: "/usr/bin:/bin",
          platform: "darwin",
          remoteIp: "100.0.0.11",
          version: "1.2.3",
        },
      ],
      pairedDevices: [
        {
          approvedAtMs: 99,
          clientId: "openclaw-macos",
          clientMode: "node",
          createdAtMs: 1,
          deviceId: "mac-1",
          displayName: "Mac",
          publicKey: "public-key",
          remoteIp: "100.0.0.10",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              createdAtMs: 1,
              role: "node",
              scopes: [],
              token: "current-token",
            },
          },
        },
      ],
      pairedNodes: [
        {
          approvedAtMs: 100,
          caps: ["camera"],
          commands: ["system.run"],
          coreVersion: "1.2.0",
          createdAtMs: 1,
          displayName: "Mac",
          nodeId: "mac-1",
          platform: "darwin",
          remoteIp: "100.0.0.9",
          token: "node-token",
          uiVersion: "1.2.0",
          version: "1.2.0",
        },
      ],
    });

    const entry = getKnownNodeEntry(catalog, "mac-1");
    expect(entry?.nodePairing).toEqual(
      expect.objectContaining({
        approvedAtMs: 100,
        caps: ["camera"],
        commands: ["system.run"],
      }),
    );
    expect(getKnownNode(catalog, "mac-1")).toEqual(
      expect.objectContaining({
        approvedAtMs: 100,
        caps: ["camera", "screen"],
        clientId: "openclaw-macos",
        clientMode: "node",
        commands: ["screen.snapshot", "system.run"],
        connected: true,
        connectedAtMs,
        displayName: "Mac",
        nodeId: "mac-1",
        paired: true,
        pathEnv: "/usr/bin:/bin",
        remoteIp: "100.0.0.11",
      }),
    );
  });

  it("surfaces node-pair metadata even when the node is offline", () => {
    const catalog = createKnownNodeCatalog({
      connectedNodes: [],
      pairedDevices: [
        {
          approvedAtMs: 99,
          clientId: "openclaw-macos",
          clientMode: "node",
          createdAtMs: 1,
          deviceId: "mac-1",
          displayName: "Mac",
          publicKey: "public-key",
          role: "node",
          roles: ["node"],
          tokens: {
            node: {
              createdAtMs: 1,
              role: "node",
              scopes: [],
              token: "current-token",
            },
          },
        },
      ],
      pairedNodes: [
        {
          approvedAtMs: 123,
          caps: ["system"],
          commands: ["system.run"],
          createdAtMs: 1,
          nodeId: "mac-1",
          platform: "darwin",
          token: "node-token",
        },
      ],
    });

    const entry = getKnownNodeEntry(catalog, "mac-1");
    expect(entry?.live).toBeUndefined();
    expect(entry?.nodePairing).toEqual(
      expect.objectContaining({
        approvedAtMs: 123,
        caps: ["system"],
        commands: ["system.run"],
      }),
    );
    expect(getKnownNode(catalog, "mac-1")).toEqual(
      expect.objectContaining({
        approvedAtMs: 123,
        caps: ["system"],
        commands: ["system.run"],
        connected: false,
        nodeId: "mac-1",
        paired: true,
      }),
    );
  });

  it("prefers the live command surface for connected nodes", () => {
    const catalog = createKnownNodeCatalog({
      connectedNodes: [
        {
          caps: ["canvas"],
          client: {} as never,
          commands: ["canvas.snapshot"],
          connId: "conn-1",
          connectedAtMs: 1,
          displayName: "Mac",
          nodeId: "mac-1",
          platform: "darwin",
        },
      ],
      pairedDevices: [],
      pairedNodes: [
        {
          approvedAtMs: 123,
          caps: ["system"],
          commands: ["system.run"],
          createdAtMs: 1,
          nodeId: "mac-1",
          platform: "darwin",
          token: "node-token",
        },
      ],
    });

    expect(getKnownNode(catalog, "mac-1")).toEqual(
      expect.objectContaining({
        caps: ["canvas"],
        commands: ["canvas.snapshot"],
        connected: true,
      }),
    );
  });
});
