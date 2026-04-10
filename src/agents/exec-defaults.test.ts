import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import * as execApprovals from "../infra/exec-approvals.js";
import { resolveExecDefaults } from "./exec-defaults.js";

describe("resolveExecDefaults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
      agents: {},
      version: 1,
    });
  });

  it("does not advertise node routing when exec host is pinned to gateway", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
        sandboxAvailable: false,
      }).canRequestNode,
    ).toBe(false);
  });

  it("keeps node routing available when exec host is auto", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      canRequestNode: true,
      effectiveHost: "sandbox",
      host: "auto",
    });
  });

  it("honors session-level exec host overrides", () => {
    const sessionEntry = {
      execHost: "node",
    } as SessionEntry;
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
        sandboxAvailable: false,
        sessionEntry,
      }).canRequestNode,
    ).toBe(true);
  });

  it("uses host approval defaults for gateway when exec policy is unset", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      ask: "off",
      effectiveHost: "gateway",
      host: "auto",
      security: "full",
    });
  });

  it("keeps sandbox deny by default when auto resolves to sandbox", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      ask: "off",
      effectiveHost: "sandbox",
      host: "auto",
      security: "deny",
    });
  });
});
