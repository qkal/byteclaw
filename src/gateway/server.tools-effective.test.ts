import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway tools.effective", () => {
  it("returns effective tool inventory data", async () => {
    await withServer(async (ws) => {
      await connectOk(ws, { scopes: ["operator.read", "operator.write"], token: "secret" });
      const created = await rpcReq<{ key?: string }>(ws, "sessions.create", {
        label: "Tools Effective Test",
      });
      expect(created.ok).toBe(true);
      const sessionKey = created.payload?.key;
      expect(sessionKey).toBeTruthy();
      const res = await rpcReq<{
        agentId?: string;
        groups?: {
          id?: "core" | "plugin" | "channel";
          source?: "core" | "plugin" | "channel";
          tools?: { id?: string; source?: "core" | "plugin" | "channel" }[];
        }[];
      }>(ws, "tools.effective", { sessionKey });

      expect(res.ok).toBe(true);
      expect(res.payload?.agentId).toBeTruthy();
      expect((res.payload?.groups ?? []).length).toBeGreaterThan(0);
      expect(
        (res.payload?.groups ?? []).some((group) =>
          (group.tools ?? []).some((tool) => tool.id === "exec"),
        ),
      ).toBe(true);
    });
  });

  it("rejects unknown agent ids", async () => {
    await withServer(async (ws) => {
      await connectOk(ws, { scopes: ["operator.read", "operator.write"], token: "secret" });
      const created = await rpcReq<{ key?: string }>(ws, "sessions.create", {
        label: "Tools Effective Test",
      });
      expect(created.ok).toBe(true);
      const unknownAgent = await rpcReq(ws, "tools.effective", {
        agentId: "does-not-exist",
        sessionKey: created.payload?.key,
      });
      expect(unknownAgent.ok).toBe(false);
      expect(unknownAgent.error?.message ?? "").toContain("unknown agent id");
    });
  });
});
