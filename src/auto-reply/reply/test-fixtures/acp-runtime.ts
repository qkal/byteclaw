import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";

export function createAcpTestConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      stream: {
        coalesceIdleMs: 0,
        maxChunkChars: 64,
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

export function createAcpSessionMeta(overrides?: Partial<SessionAcpMeta>): SessionAcpMeta {
  return {
    agent: "codex",
    backend: "acpx",
    identity: {
      acpxSessionId: "acpx-session-1",
      lastUpdatedAt: Date.now(),
      source: "status",
      state: "resolved",
    },
    lastActivityAt: Date.now(),
    mode: "persistent",
    runtimeSessionName: "runtime:1",
    state: "idle",
    ...overrides,
  };
}
