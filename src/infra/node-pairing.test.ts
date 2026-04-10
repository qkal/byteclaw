import { describe, expect, test } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  requestNodePairing,
  verifyNodeToken,
} from "./node-pairing.js";

async function setupPairedNode(baseDir: string): Promise<string> {
  const request = await requestNodePairing(
    {
      commands: ["system.run"],
      nodeId: "node-1",
      platform: "darwin",
    },
    baseDir,
  );
  await approveNodePairing(
    request.request.requestId,
    { callerScopes: ["operator.pairing", "operator.admin"] },
    baseDir,
  );
  const paired = await getPairedNode("node-1", baseDir);
  expect(paired).not.toBeNull();
  if (!paired) {
    throw new Error("expected node to be paired");
  }
  return paired.token;
}

async function withNodePairingDir<T>(run: (baseDir: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-node-pairing-" }, run);
}

describe("node pairing tokens", () => {
  test("reuses existing pending requests for the same node", async () => {
    await withNodePairingDir(async (baseDir) => {
      const first = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );
      const second = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.request.requestId).toBe(first.request.requestId);
    });
  });

  test("refreshes pending requests with newer commands", async () => {
    await withNodePairingDir(async (baseDir) => {
      const first = await requestNodePairing(
        {
          commands: ["canvas.snapshot"],
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      const second = await requestNodePairing(
        {
          commands: ["canvas.snapshot", "system.run"],
          displayName: "Updated Node",
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );
      const third = await requestNodePairing(
        {
          commands: ["canvas.snapshot", "system.run", "system.which"],
          displayName: "Updated Node",
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      expect(second.created).toBe(false);
      expect(second.request.requestId).toBe(first.request.requestId);
      expect(third.created).toBe(false);
      expect(third.request.requestId).toBe(second.request.requestId);
      expect(third.request.displayName).toBe("Updated Node");
      expect(third.request.commands).toEqual(["canvas.snapshot", "system.run", "system.which"]);
    });
  });

  test("generates base64url node tokens with 256-bit entropy output length", async () => {
    await withNodePairingDir(async (baseDir) => {
      const token = await setupPairedNode(baseDir);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    });
  });

  test("verifies token and rejects mismatches", async () => {
    await withNodePairingDir(async (baseDir) => {
      const token = await setupPairedNode(baseDir);
      await expect(verifyNodeToken("node-1", token, baseDir)).resolves.toEqual({
        node: expect.objectContaining({ nodeId: "node-1" }),
        ok: true,
      });
      await expect(verifyNodeToken("node-1", "x".repeat(token.length), baseDir)).resolves.toEqual({
        ok: false,
      });
    });
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    await withNodePairingDir(async (baseDir) => {
      const token = await setupPairedNode(baseDir);
      const multibyteToken = "é".repeat(token.length);
      expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

      await expect(verifyNodeToken("node-1", multibyteToken, baseDir)).resolves.toEqual({
        ok: false,
      });
    });
  });

  test("requires operator.admin to approve system.run node commands", async () => {
    await withNodePairingDir(async (baseDir) => {
      const request = await requestNodePairing(
        {
          commands: ["system.run"],
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      ).resolves.toEqual({
        missingScope: "operator.admin",
        status: "forbidden",
      });
      await expect(getPairedNode("node-1", baseDir)).resolves.toBeNull();
    });
  });

  test("requires operator.write to approve non-exec node commands", async () => {
    await withNodePairingDir(async (baseDir) => {
      const request = await requestNodePairing(
        {
          commands: ["canvas.present"],
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      ).resolves.toEqual({
        missingScope: "operator.write",
        status: "forbidden",
      });
      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.write"] },
          baseDir,
        ),
      ).resolves.toEqual({
        missingScope: "operator.pairing",
        status: "forbidden",
      });
      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing", "operator.write"] },
          baseDir,
        ),
      ).resolves.toEqual({
        node: expect.objectContaining({
          commands: ["canvas.present"],
          nodeId: "node-1",
        }),
        requestId: request.request.requestId,
      });
    });
  });

  test("requires operator.pairing to approve commandless node requests", async () => {
    await withNodePairingDir(async (baseDir) => {
      const request = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      await expect(
        approveNodePairing(request.request.requestId, { callerScopes: [] }, baseDir),
      ).resolves.toEqual({
        missingScope: "operator.pairing",
        status: "forbidden",
      });
      await expect(
        approveNodePairing(
          request.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      ).resolves.toEqual({
        node: expect.objectContaining({
          commands: undefined,
          nodeId: "node-1",
        }),
        requestId: request.request.requestId,
      });
    });
  });

  test("lists pending requests with precomputed approval scopes", async () => {
    await withNodePairingDir(async (baseDir) => {
      await requestNodePairing(
        {
          commands: ["canvas.present"],
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      await expect(listNodePairing(baseDir)).resolves.toEqual({
        paired: [],
        pending: [
          expect.objectContaining({
            commands: ["canvas.present"],
            nodeId: "node-1",
            requiredApproveScopes: ["operator.pairing", "operator.write"],
          }),
        ],
      });
    });
  });
});
