import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../src/config/sessions.js";
import {
  createDiscordNativeApprovalAdapter,
  getDiscordApprovalCapability,
  shouldHandleDiscordApprovalRequest,
} from "./approval-native.js";

const STORE_PATH = path.join(os.tmpdir(), "openclaw-discord-approval-native-test.json");
const NATIVE_APPROVAL_CFG = {
  commands: {
    ownerAllowFrom: ["discord:555555555"],
  },
} as const;

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

describe("createDiscordNativeApprovalAdapter", () => {
  it("keeps approval availability enabled when approvers exist but native delivery is off", () => {
    const adapter = createDiscordNativeApprovalAdapter({
      approvers: ["555555555"],
      enabled: false,
      target: "channel",
    } as never);

    expect(
      adapter.auth?.getActionAvailabilityState?.({
        accountId: "main",
        action: "approve",
        cfg: NATIVE_APPROVAL_CFG as never,
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      adapter.native?.describeDeliveryCapabilities({
        accountId: "main",
        approvalKind: "exec",
        cfg: NATIVE_APPROVAL_CFG as never,
        request: {
          createdAtMs: 1,
          expiresAtMs: 2,
          id: "approval-1",
          request: {
            command: "pwd",
            sessionKey: "agent:main:discord:channel:123456789",
            turnSourceAccountId: "main",
            turnSourceChannel: "discord",
            turnSourceTo: "channel:123456789",
          },
        },
      }),
    ).toEqual({
      enabled: false,
      notifyOriginWhenDmOnly: true,
      preferredSurface: "origin",
      supportsApproverDmSurface: true,
      supportsOriginSurface: true,
    });
  });

  it("honors ownerAllowFrom fallback when gating approval requests", () => {
    expect(
      shouldHandleDiscordApprovalRequest({
        accountId: "main",
        cfg: {
          commands: {
            ownerAllowFrom: ["discord:123"],
          },
        } as never,
        configOverride: { enabled: true } as never,
        request: {
          createdAtMs: 1,
          expiresAtMs: 2,
          id: "approval-1",
          request: {
            command: "pwd",
            turnSourceAccountId: "main",
            turnSourceChannel: "discord",
            turnSourceTo: "channel:123456789",
          },
        },
      }),
    ).toBe(true);
  });

  it("describes the correct Discord exec-approval setup path", () => {
    const text = getDiscordApprovalCapability().describeExecApprovalSetup?.({
      channel: "discord",
      channelLabel: "Discord",
    });

    expect(text).toContain("`channels.discord.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.discord.dm.allowFrom`");
  });

  it("describes the named-account Discord exec-approval setup path", () => {
    const text = getDiscordApprovalCapability().describeExecApprovalSetup?.({
      accountId: "work",
      channel: "discord",
      channelLabel: "Discord",
    });

    expect(text).toContain("`channels.discord.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.discord.execApprovals.approvers`");
  });

  it("normalizes prefixed turn-source channel ids", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: NATIVE_APPROVAL_CFG as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          title: "Plugin approval",
          turnSourceAccountId: "main",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123456789",
        },
      },
    });

    expect(target).toEqual({ to: "123456789" });
  });

  it("falls back to approver DMs for Discord DM sessions with raw turn-source ids", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: NATIVE_APPROVAL_CFG as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:dm:123456789",
          title: "Plugin approval",
          turnSourceAccountId: "main",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
        },
      },
    });

    expect(target).toBeNull();
  });

  it("ignores session-store turn targets for Discord DM sessions", async () => {
    writeStore({
      "agent:main:discord:dm:123456789": {
        lastAccountId: "main",
        lastChannel: "discord",
        lastTo: "123456789",
        origin: { accountId: "main", provider: "discord", to: "123456789" },
        sessionId: "sess",
        updatedAt: Date.now(),
      },
    });

    const adapter = createDiscordNativeApprovalAdapter();
    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: {
        ...NATIVE_APPROVAL_CFG,
        session: { store: STORE_PATH },
      } as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:dm:123456789",
          title: "Plugin approval",
          turnSourceAccountId: "main",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
        },
      },
    });

    expect(target).toBeNull();
  });

  it("accepts raw turn-source ids when a Discord channel session backs them", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: NATIVE_APPROVAL_CFG as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:123456789",
          title: "Plugin approval",
          turnSourceAccountId: "main",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
        },
      },
    });

    expect(target).toEqual({ threadId: undefined, to: "123456789" });
  });

  it("falls back to extracting the channel id from the session key", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: NATIVE_APPROVAL_CFG as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:987654321",
          title: "Plugin approval",
        },
      },
    });

    expect(target).toEqual({ threadId: undefined, to: "987654321" });
  });

  it("preserves explicit turn-source thread ids on origin targets", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: NATIVE_APPROVAL_CFG as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:123456789:thread:777888999",
          title: "Plugin approval",
          turnSourceAccountId: "main",
          turnSourceChannel: "discord",
          turnSourceThreadId: "777888999",
          turnSourceTo: "channel:123456789",
        },
      },
    });

    expect(target).toEqual({ threadId: "777888999", to: "123456789" });
  });

  it("falls back to extracting thread ids from the session key", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: NATIVE_APPROVAL_CFG as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:987654321:thread:444555666",
          title: "Plugin approval",
        },
      },
    });

    expect(target).toEqual({ threadId: "444555666", to: "987654321" });
  });

  it("rejects origin delivery for requests bound to another Discord account", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      accountId: "main",
      approvalKind: "plugin",
      cfg: NATIVE_APPROVAL_CFG as never,
      request: {
        createdAtMs: 1,
        expiresAtMs: 2,
        id: "abc",
        request: {
          description: "Let plugin proceed",
          sessionKey: "agent:main:missing",
          title: "Plugin approval",
          turnSourceAccountId: "other",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123456789",
        },
      },
    });

    expect(target).toBeNull();
  });
});
