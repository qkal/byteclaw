import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const resolveAllAgentSessionStoreTargetsMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  return {
    loadSessionStoreMock,
    resolveAllAgentSessionStoreTargetsMock,
  };
});

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => hoisted.loadSessionStoreMock(storePath),
}));

vi.mock("../../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargets: (cfg: OpenClawConfig, opts: unknown) =>
    hoisted.resolveAllAgentSessionStoreTargetsMock(cfg, opts),
}));
let listAcpSessionEntries: typeof import("./session-meta.js").listAcpSessionEntries;

describe("listAcpSessionEntries", () => {
  beforeAll(async () => {
    ({ listAcpSessionEntries } = await import("./session-meta.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads ACP sessions from resolved configured store targets", async () => {
    const cfg = {
      session: {
        store: "/custom/sessions/{agentId}.json",
      },
    } as OpenClawConfig;
    hoisted.resolveAllAgentSessionStoreTargetsMock.mockResolvedValue([
      {
        agentId: "ops",
        storePath: "/custom/sessions/ops.json",
      },
    ]);
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:ops:acp:s1": {
        acp: {
          agent: "ops",
          backend: "acpx",
          mode: "persistent",
          state: "idle",
        },
        updatedAt: 123,
      },
    });

    const entries = await listAcpSessionEntries({ cfg });

    expect(hoisted.resolveAllAgentSessionStoreTargetsMock).toHaveBeenCalledWith(cfg, undefined);
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledWith("/custom/sessions/ops.json");
    expect(entries).toEqual([
      expect.objectContaining({
        cfg,
        sessionKey: "agent:ops:acp:s1",
        storePath: "/custom/sessions/ops.json",
        storeSessionKey: "agent:ops:acp:s1",
      }),
    ]);
  });
});
