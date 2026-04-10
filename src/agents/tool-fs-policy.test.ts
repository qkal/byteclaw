import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveEffectiveToolFsWorkspaceOnly,
} from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ agentId: "main", cfg: {} })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ agentId: "main", cfg })).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override over global setting", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ agentId: "main", cfg })).toBe(false);
  });

  it("supports agent-specific enablement when global workspaceOnly is off", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
      tools: { fs: { workspaceOnly: false } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ agentId: "main", cfg })).toBe(true);
  });
});

describe("resolveEffectiveToolFsRootExpansionAllowed", () => {
  it("allows root expansion by default when no restrictive profile is configured", () => {
    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "main", cfg: {} })).toBe(true);
  });

  it("disables root expansion for messaging profile agents without filesystem opt-in", () => {
    const cfg: OpenClawConfig = {
      tools: { profile: "messaging" },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "main", cfg })).toBe(false);
  });

  it("re-enables root expansion when tools.fs explicitly allows non-workspace reads", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: false },
        profile: "messaging",
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "main", cfg })).toBe(true);
  });

  it("treats an explicit tools.fs block as a filesystem opt-in", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: {},
        profile: "messaging",
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "main", cfg })).toBe(true);
  });

  it("keeps root expansion disabled when tools.fs only restricts access to the workspace", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
        profile: "messaging",
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "main", cfg })).toBe(false);
  });

  it("prefers agent profile overrides over the global profile in both directions", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "coder", tools: { profile: "coding" } },
          { id: "messenger", tools: { profile: "messaging" } },
        ],
      },
      tools: { profile: "messaging" },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "coder", cfg })).toBe(true);

    const invertedCfg: OpenClawConfig = {
      agents: {
        list: [{ id: "messenger", tools: { profile: "messaging" } }],
      },
      tools: { profile: "coding" },
    };

    expect(
      resolveEffectiveToolFsRootExpansionAllowed({ agentId: "messenger", cfg: invertedCfg }),
    ).toBe(false);
  });

  it("uses agent alsoAllow in place of global alsoAllow when resolving expansion", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "messenger",
            tools: {
              alsoAllow: ["message"],
            },
          },
        ],
      },
      tools: {
        alsoAllow: ["read"],
        profile: "messaging",
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "messenger", cfg })).toBe(false);
  });

  it("honors agent workspaceOnly overrides over global fs opt-in", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "messenger",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
      tools: {
        fs: { workspaceOnly: false },
        profile: "messaging",
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ agentId: "messenger", cfg })).toBe(false);
  });
});
