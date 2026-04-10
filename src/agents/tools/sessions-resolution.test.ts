import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
let isResolvedSessionVisibleToRequester: typeof import("./sessions-resolution.js").isResolvedSessionVisibleToRequester;
let looksLikeSessionId: typeof import("./sessions-resolution.js").looksLikeSessionId;
let looksLikeSessionKey: typeof import("./sessions-resolution.js").looksLikeSessionKey;
let resolveDisplaySessionKey: typeof import("./sessions-resolution.js").resolveDisplaySessionKey;
let resolveInternalSessionKey: typeof import("./sessions-resolution.js").resolveInternalSessionKey;
let resolveMainSessionAlias: typeof import("./sessions-resolution.js").resolveMainSessionAlias;
let resolveSessionReference: typeof import("./sessions-resolution.js").resolveSessionReference;
let shouldVerifyRequesterSpawnedSessionVisibility: typeof import("./sessions-resolution.js").shouldVerifyRequesterSpawnedSessionVisibility;
let shouldResolveSessionIdInput: typeof import("./sessions-resolution.js").shouldResolveSessionIdInput;

beforeAll(async () => {
  ({
    isResolvedSessionVisibleToRequester,
    looksLikeSessionId,
    looksLikeSessionKey,
    resolveDisplaySessionKey,
    resolveInternalSessionKey,
    resolveMainSessionAlias,
    resolveSessionReference,
    shouldVerifyRequesterSpawnedSessionVisibility,
    shouldResolveSessionIdInput,
  } = await import("./sessions-resolution.js"));
});

beforeEach(() => {
  callGatewayMock.mockReset();
});

describe("resolveMainSessionAlias", () => {
  it("uses normalized main key and global alias for global scope", () => {
    const cfg = {
      session: { mainKey: " Primary ", scope: "global" },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      alias: "global",
      mainKey: "primary",
      scope: "global",
    });
  });

  it("falls back to per-sender defaults", () => {
    expect(resolveMainSessionAlias({} as OpenClawConfig)).toEqual({
      alias: "main",
      mainKey: "main",
      scope: "per-sender",
    });
  });

  it("uses session.mainKey over any legacy routing sessions key", () => {
    const cfg = {
      routing: { sessions: { mainKey: "legacy-main" } },
      session: { mainKey: "  work ", scope: "per-sender" },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      alias: "work",
      mainKey: "work",
      scope: "per-sender",
    });
  });
});

describe("session key display/internal mapping", () => {
  it("maps alias and main key to display main", () => {
    expect(resolveDisplaySessionKey({ alias: "global", key: "global", mainKey: "main" })).toBe(
      "main",
    );
    expect(resolveDisplaySessionKey({ alias: "global", key: "main", mainKey: "main" })).toBe(
      "main",
    );
    expect(
      resolveDisplaySessionKey({ alias: "global", key: "agent:ops:main", mainKey: "main" }),
    ).toBe("agent:ops:main");
  });

  it("maps input main to alias for internal routing", () => {
    expect(resolveInternalSessionKey({ alias: "global", key: "main", mainKey: "main" })).toBe(
      "global",
    );
    expect(
      resolveInternalSessionKey({ alias: "global", key: "agent:ops:main", mainKey: "main" }),
    ).toBe("agent:ops:main");
  });

  it("maps current to requester session key", () => {
    expect(
      resolveInternalSessionKey({
        alias: "global",
        key: "current",
        mainKey: "main",
        requesterInternalKey: "agent:support:main",
      }),
    ).toBe("agent:support:main");
  });

  it("preserves literal current when no requester key is provided", () => {
    expect(resolveInternalSessionKey({ alias: "global", key: "current", mainKey: "main" })).toBe(
      "current",
    );
  });
});

describe("session reference shape detection", () => {
  it("detects session ids", () => {
    expect(looksLikeSessionId("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(looksLikeSessionId("not-a-uuid")).toBe(false);
  });

  it("detects canonical session key families", () => {
    expect(looksLikeSessionKey("main")).toBe(true);
    expect(looksLikeSessionKey("current")).toBe(true);
    expect(looksLikeSessionKey("agent:main:main")).toBe(true);
    expect(looksLikeSessionKey("cron:daily-report")).toBe(true);
    expect(looksLikeSessionKey("node:macbook")).toBe(true);
    expect(looksLikeSessionKey("telegram:group:123")).toBe(true);
    expect(looksLikeSessionKey("random-slug")).toBe(false);
  });

  it("treats non-keys as session-id candidates", () => {
    expect(shouldResolveSessionIdInput("agent:main:main")).toBe(false);
    expect(shouldResolveSessionIdInput("current")).toBe(false);
    expect(shouldResolveSessionIdInput("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(shouldResolveSessionIdInput("random-slug")).toBe(true);
  });
});

describe("resolved session visibility checks", () => {
  it("requires spawned-session verification only for sandboxed key-based cross-session access", () => {
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        resolvedViaSessionId: false,
        restrictToSpawned: true,
        targetSessionKey: "agent:main:worker",
      }),
    ).toBe(true);
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        resolvedViaSessionId: false,
        restrictToSpawned: false,
        targetSessionKey: "agent:main:worker",
      }),
    ).toBe(false);
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        resolvedViaSessionId: true,
        restrictToSpawned: true,
        targetSessionKey: "agent:main:worker",
      }),
    ).toBe(false);
    expect(
      shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: "agent:main:main",
        resolvedViaSessionId: false,
        restrictToSpawned: true,
        targetSessionKey: "agent:main:main",
      }),
    ).toBe(false);
  });

  it("returns true immediately when spawned-session verification is not required", async () => {
    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        resolvedViaSessionId: false,
        restrictToSpawned: true,
        targetSessionKey: "agent:main:main",
      }),
    ).resolves.toBe(true);
    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        resolvedViaSessionId: false,
        restrictToSpawned: false,
        targetSessionKey: "agent:main:other",
      }),
    ).resolves.toBe(true);
  });

  it("does not hide an exact spawned target behind the sessions.list visibility cap", async () => {
    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: { key?: string } }) => {
        if (request.method === "sessions.resolve") {
          return { key: request.params?.key };
        }
        if (request.method === "sessions.list") {
          return {
            sessions: Array.from({ length: 500 }, (_, index) => ({
              key: `agent:main:subagent:worker-${index}`,
            })),
          };
        }
        return {};
      },
    );

    await expect(
      isResolvedSessionVisibleToRequester({
        requesterSessionKey: "agent:main:main",
        resolvedViaSessionId: false,
        restrictToSpawned: true,
        targetSessionKey: "agent:main:subagent:worker-999",
      }),
    ).resolves.toBe(true);
  });
});

describe("resolveSessionReference", () => {
  it("prefers a literal current session key before alias fallback", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "current" });

    await expect(
      resolveSessionReference({
        alias: "main",
        mainKey: "main",
        requesterInternalKey: "agent:main:subagent:child",
        restrictToSpawned: false,
        sessionKey: "current",
      }),
    ).resolves.toMatchObject({
      displayKey: "current",
      key: "current",
      ok: true,
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "current",
        spawnedBy: undefined,
      },
    });
  });

  it("prefers a literal current sessionId before alias fallback", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:main" });

    await expect(
      resolveSessionReference({
        alias: "main",
        mainKey: "main",
        requesterInternalKey: "agent:main:subagent:child",
        restrictToSpawned: false,
        sessionKey: "current",
      }),
    ).resolves.toMatchObject({
      displayKey: "agent:ops:main",
      key: "agent:ops:main",
      ok: true,
      resolvedViaSessionId: true,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.resolve",
      params: {
        key: "current",
        spawnedBy: undefined,
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "sessions.resolve",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        sessionId: "current",
        spawnedBy: undefined,
      },
    });
  });

  it("skips literal current key lookup when spawned visibility is restricted", async () => {
    await expect(
      resolveSessionReference({
        alias: "main",
        mainKey: "main",
        requesterInternalKey: "agent:main:subagent:child",
        restrictToSpawned: true,
        sessionKey: "current",
      }),
    ).resolves.toMatchObject({
      displayKey: "agent:main:subagent:child",
      key: "agent:main:subagent:child",
      ok: true,
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.resolve",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        sessionId: "current",
        spawnedBy: "agent:main:subagent:child",
      },
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });
});
