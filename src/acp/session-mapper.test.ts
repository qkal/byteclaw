import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { parseSessionMeta, resolveSessionKey } from "./session-mapper.js";

function createGateway(resolveLabelKey = "agent:main:label"): {
  gateway: GatewayClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.resolve" && "label" in params) {
      return { key: resolveLabelKey, ok: true };
    }
    if (method === "sessions.resolve" && "key" in params) {
      return { key: params.key as string, ok: true };
    }
    return { ok: true };
  });

  return {
    gateway: { request } as unknown as GatewayClient,
    request,
  };
}

describe("acp session mapper", () => {
  it("prefers explicit sessionLabel over sessionKey", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({ sessionKey: "agent:main:main", sessionLabel: "support" });

    const key = await resolveSessionKey({
      fallbackKey: "acp:fallback",
      gateway,
      meta,
      opts: {},
    });

    expect(key).toBe("agent:main:label");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.resolve", { label: "support" });
  });

  it("lets meta sessionKey override default label", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({ sessionKey: "agent:main:override" });

    const key = await resolveSessionKey({
      fallbackKey: "acp:fallback",
      gateway,
      meta,
      opts: { defaultSessionLabel: "default-label" },
    });

    expect(key).toBe("agent:main:override");
    expect(request).not.toHaveBeenCalled();
  });
});
