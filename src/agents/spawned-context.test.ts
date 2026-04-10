import { describe, expect, it } from "vitest";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSpawnedRun,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";

describe("normalizeSpawnedRunMetadata", () => {
  it("trims text fields and drops empties", () => {
    expect(
      normalizeSpawnedRunMetadata({
        groupChannel: "  slack ",
        groupId: "  group-1 ",
        groupSpace: " ",
        spawnedBy: "  agent:main:subagent:1 ",
        workspaceDir: " /tmp/ws ",
      }),
    ).toEqual({
      groupChannel: "slack",
      groupId: "group-1",
      spawnedBy: "agent:main:subagent:1",
      workspaceDir: "/tmp/ws",
    });
  });
});

describe("mapToolContextToSpawnedRunMetadata", () => {
  it("maps agent group fields to run metadata shape", () => {
    expect(
      mapToolContextToSpawnedRunMetadata({
        agentGroupChannel: "telegram",
        agentGroupId: "g-1",
        agentGroupSpace: "topic:123",
        workspaceDir: "/tmp/ws",
      }),
    ).toEqual({
      groupChannel: "telegram",
      groupId: "g-1",
      groupSpace: "topic:123",
      workspaceDir: "/tmp/ws",
    });
  });
});

describe("resolveSpawnedWorkspaceInheritance", () => {
  const config = {
    agents: {
      list: [
        { id: "main", workspace: "/tmp/workspace-main" },
        { id: "ops", workspace: "/tmp/workspace-ops" },
      ],
    },
  };

  it("prefers explicit workspaceDir when provided", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      explicitWorkspaceDir: " /tmp/explicit ",
      requesterSessionKey: "agent:main:subagent:parent",
    });
    expect(resolved).toBe("/tmp/explicit");
  });

  it("prefers targetAgentId over requester session agent for cross-agent spawns", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: "agent:main:subagent:parent",
      targetAgentId: "ops",
    });
    expect(resolved).toBe("/tmp/workspace-ops");
  });

  it("falls back to requester session agent when targetAgentId is missing", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: "agent:main:subagent:parent",
    });
    expect(resolved).toBe("/tmp/workspace-main");
  });

  it("returns undefined for missing requester context", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      explicitWorkspaceDir: undefined,
      requesterSessionKey: undefined,
    });
    expect(resolved).toBeUndefined();
  });
});

describe("resolveIngressWorkspaceOverrideForSpawnedRun", () => {
  it("forwards workspace only for spawned runs", () => {
    expect(
      resolveIngressWorkspaceOverrideForSpawnedRun({
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/ws",
      }),
    ).toBe("/tmp/ws");
    expect(
      resolveIngressWorkspaceOverrideForSpawnedRun({
        spawnedBy: "",
        workspaceDir: "/tmp/ws",
      }),
    ).toBeUndefined();
  });
});
