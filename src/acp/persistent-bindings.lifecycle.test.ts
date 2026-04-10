import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildConfiguredAcpSessionKey } from "./persistent-bindings.types.js";

const managerMocks = vi.hoisted(() => ({
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
  resolveSession: vi.fn(),
  updateSessionRuntimeOptions: vi.fn(),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn(),
}));

const resolveMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingSpecBySessionKey: vi.fn(),
}));

vi.mock("./control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    closeSession: managerMocks.closeSession,
    initializeSession: managerMocks.initializeSession,
    resolveSession: managerMocks.resolveSession,
    updateSessionRuntimeOptions: managerMocks.updateSessionRuntimeOptions,
  }),
}));

vi.mock("./runtime/session-meta.js", () => ({
  readAcpSessionEntry: sessionMetaMocks.readAcpSessionEntry,
}));

vi.mock("./persistent-bindings.resolve.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey:
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey,
}));
const baseCfg = {
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

let resetAcpSessionInPlace: typeof import("./persistent-bindings.lifecycle.js").resetAcpSessionInPlace;

beforeAll(async () => {
  ({ resetAcpSessionInPlace } = await import("./persistent-bindings.lifecycle.js"));
});

beforeEach(() => {
  managerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
  managerMocks.closeSession.mockReset().mockResolvedValue({
    metaCleared: false,
    runtimeClosed: true,
  });
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.updateSessionRuntimeOptions.mockReset().mockResolvedValue(undefined);
  sessionMetaMocks.readAcpSessionEntry.mockReset().mockReturnValue(undefined);
  resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReset().mockReturnValue(null);
});

describe("resetAcpSessionInPlace", () => {
  it("clears configured bindings and lets the next turn recreate them", async () => {
    const spec = {
      accountId: "default",
      agentId: "claude",
      backend: "acpx",
      channel: "demo-binding",
      conversationId: "9373ab192b2317f4",
      cwd: "/home/bob/clawd",
      mode: "persistent",
    } as const;
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReturnValue(spec);
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        backend: "acpx",
        mode: "persistent",
        runtimeOptions: { cwd: "/home/bob/clawd" },
      },
    });

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      reason: "reset",
      sessionKey,
    });

    expect(result).toEqual({ ok: true });
    expect(resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey).toHaveBeenCalledTimes(1);
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clearMeta: true,
        discardPersistentState: true,
        sessionKey,
      }),
    );
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
    expect(managerMocks.updateSessionRuntimeOptions).not.toHaveBeenCalled();
  });

  it("falls back to close-only resets when no configured binding exists", async () => {
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:9373ab192b2317f4";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        backend: "acpx",
        mode: "persistent",
      },
    });

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      reason: "reset",
      sessionKey,
    });

    expect(result).toEqual({ ok: true });
    expect(resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey).toHaveBeenCalledTimes(1);
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clearMeta: false,
        sessionKey,
      }),
    );
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });

  it("can force metadata clearing for bound ACP targets outside the configured registry", async () => {
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:9373ab192b2317f4";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        backend: "acpx",
        mode: "persistent",
      },
    });

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      clearMeta: true,
      reason: "new",
      sessionKey,
    });

    expect(result).toEqual({ ok: true });
    expect(resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey).toHaveBeenCalledTimes(1);
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clearMeta: true,
        sessionKey,
      }),
    );
  });

  it("treats configured bindings with no ACP metadata as already reset", async () => {
    const spec = {
      accountId: "default",
      agentId: "claude",
      backend: "acpx",
      channel: "demo-binding",
      conversationId: "9373ab192b2317f4",
      cwd: "/home/bob/clawd",
      mode: "persistent",
    } as const;
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReturnValue(spec);

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      reason: "new",
      sessionKey,
    });

    expect(result).toEqual({ ok: true });
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });
});
