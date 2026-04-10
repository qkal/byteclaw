import { describe, expect, it } from "vitest";
import { resolveControlCommandGate } from "../../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  authorizeMattermostCommandInvocation,
  resolveMattermostEffectiveAllowFromLists,
} from "./monitor-auth.js";

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  baseUrl: "https://chat.example.com",
  baseUrlSource: "config",
  botToken: "bot-token",
  botTokenSource: "config",
  config: {},
  enabled: true,
};

function authorizeGroupCommand(senderId: string) {
  return authorizeMattermostCommandInvocation({
    account: {
      ...accountFixture,
      config: {
        allowFrom: ["trusted-user"],
        groupPolicy: "allowlist",
      },
    },
    allowTextCommands: true,
    cfg: {
      commands: {
        useAccessGroups: true,
      },
    },
    channelId: "chan-1",
    channelInfo: {
      display_name: "General",
      id: "chan-1",
      name: "general",
      type: "O",
    },
    hasControlCommand: true,
    senderId,
    senderName: senderId,
    storeAllowFrom: [],
  });
}

describe("mattermost monitor authz", () => {
  it("keeps DM allowlist merged with pairing-store entries", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      allowFrom: ["@trusted-user"],
      dmPolicy: "pairing",
      groupAllowFrom: ["@group-owner"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
  });

  it("uses explicit groupAllowFrom without pairing-store inheritance", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      allowFrom: ["@trusted-user"],
      dmPolicy: "pairing",
      groupAllowFrom: ["@group-owner"],
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveGroupAllowFrom).toEqual(["group-owner"]);
  });

  it("does not inherit pairing-store entries into group allowlist", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      allowFrom: ["@trusted-user"],
      dmPolicy: "pairing",
      storeAllowFrom: ["user:attacker"],
    });

    expect(resolved.effectiveAllowFrom).toEqual(["trusted-user", "attacker"]);
    expect(resolved.effectiveGroupAllowFrom).toEqual(["trusted-user"]);
  });

  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const resolved = resolveMattermostEffectiveAllowFromLists({
      allowFrom: [],
      dmPolicy: "open",
      groupAllowFrom: [],
      storeAllowFrom: [],
    });

    const commandGate = resolveControlCommandGate({
      allowTextCommands: true,
      authorizers: [
        { allowed: false, configured: resolved.effectiveAllowFrom.length > 0 },
        { allowed: false, configured: resolved.effectiveGroupAllowFrom.length > 0 },
      ],
      hasControlCommand: true,
      useAccessGroups: true,
    });

    expect(commandGate.commandAuthorized).toBe(false);
  });

  it("denies group control commands when the sender is outside the allowlist", () => {
    const decision = authorizeGroupCommand("attacker");

    expect(decision).toMatchObject({
      denyReason: "unauthorized",
      kind: "channel",
      ok: false,
    });
  });

  it("authorizes group control commands for allowlisted senders", () => {
    const decision = authorizeGroupCommand("trusted-user");

    expect(decision).toMatchObject({
      commandAuthorized: true,
      kind: "channel",
      ok: true,
    });
  });
});
