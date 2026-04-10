import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../src/config/sessions.js";
import { telegramApprovalCapability, telegramNativeApprovalAdapter } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals: {
          approvers: ["8460800771"],
          enabled: true,
          target: "dm",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const STORE_PATH = path.join(os.tmpdir(), "openclaw-telegram-approval-native-test.json");

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

describe("telegram native approval adapter", () => {
  it("describes the correct Telegram exec-approval setup path", () => {
    const text = telegramApprovalCapability.describeExecApprovalSetup?.({
      channel: "telegram",
      channelLabel: "Telegram",
    });

    expect(text).toContain("`channels.telegram.execApprovals.approvers`");
    expect(text).toContain("`channels.telegram.allowFrom`");
    expect(text).toContain("`channels.telegram.defaultTo`");
    expect(text).not.toContain("`channels.telegram.dm.allowFrom`");
  });

  it("describes the named-account Telegram exec-approval setup path", () => {
    const text = telegramApprovalCapability.describeExecApprovalSetup?.({
      accountId: "work",
      channel: "telegram",
      channelLabel: "Telegram",
    });

    expect(text).toContain("`channels.telegram.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`channels.telegram.accounts.work.allowFrom`");
    expect(text).toContain("`channels.telegram.accounts.work.defaultTo`");
    expect(text).not.toContain("`channels.telegram.allowFrom`");
  });

  it("normalizes direct-chat origin targets so DM dedupe can converge", async () => {
    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:telegram:direct:8460800771",
          turnSourceAccountId: "default",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:8460800771",
        },
      },
    });

    expect(target).toEqual({
      threadId: undefined,
      to: "8460800771",
    });
  });

  it("parses topic-scoped turn-source targets in the extension", async () => {
    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-topic-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
          turnSourceAccountId: "default",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-1003841603622:topic:928",
        },
      },
    });

    expect(target).toEqual({
      threadId: 928,
      to: "-1003841603622",
    });
  });

  it("falls back to the session-bound origin target for plugin approvals", async () => {
    writeStore({
      "agent:main:telegram:group:-1003841603622:topic:928": {
        deliveryContext: {
          accountId: "default",
          channel: "telegram",
          threadId: 928,
          to: "-1003841603622",
        },
        sessionId: "sess",
        updatedAt: Date.now(),
      },
    });

    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "plugin",
      cfg: {
        ...buildConfig(),
        session: { store: STORE_PATH },
      },
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "plugin:req-1",
        request: {
          description: "Allow access",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
          title: "Plugin approval",
        },
      },
    });

    expect(target).toEqual({
      threadId: 928,
      to: "-1003841603622",
    });
  });

  it("parses numeric string thread ids from the session store for plugin approvals", async () => {
    writeStore({
      "agent:main:telegram:group:-1003841603622:topic:928": {
        deliveryContext: {
          accountId: "default",
          channel: "telegram",
          threadId: "928",
          to: "-1003841603622",
        },
        sessionId: "sess",
        updatedAt: Date.now(),
      },
    });

    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "plugin",
      cfg: {
        ...buildConfig(),
        session: { store: STORE_PATH },
      },
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "plugin:req-2",
        request: {
          description: "Allow access",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
          title: "Plugin approval",
        },
      },
    });

    expect(target).toEqual({
      threadId: 928,
      to: "-1003841603622",
    });
  });

  it("marks DM-only telegram approvals to notify the origin chat after delivery", () => {
    const capabilities = telegramNativeApprovalAdapter.native?.describeDeliveryCapabilities({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-dm-1",
        request: {
          command: "echo hi",
          turnSourceAccountId: "default",
          turnSourceChannel: "telegram",
          turnSourceThreadId: 928,
          turnSourceTo: "telegram:-1003841603622:topic:928",
        },
      },
    });

    expect(capabilities).toEqual({
      enabled: true,
      notifyOriginWhenDmOnly: true,
      preferredSurface: "approver-dm",
      supportsApproverDmSurface: true,
      supportsOriginSurface: true,
    });
  });
});
