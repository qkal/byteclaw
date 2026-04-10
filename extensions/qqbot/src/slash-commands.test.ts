import { describe, expect, it } from "vitest";
import {
  type SlashCommandContext,
  getFrameworkCommands,
  matchSlashCommand,
} from "./slash-commands.js";

/** Build a minimal SlashCommandContext for testing. */
function buildCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    accountId: "default",
    appId: "000000",
    args: "",
    commandAuthorized: true,
    eventTimestamp: new Date().toISOString(),
    messageId: "msg-001",
    queueSnapshot: {
      activeUsers: 0,
      maxConcurrentUsers: 10,
      senderPending: 0,
      totalPending: 0,
    },
    rawContent: "/bot-ping",
    receivedAt: Date.now(),
    senderId: "test-user-001",
    type: "c2c",
    ...overrides,
  };
}

describe("slash command authorization", () => {
  // ---- /bot-logs (moved to framework registerCommand) ----
  // /bot-logs is registered with the framework via registerCommand() so that
  // ResolveCommandAuthorization() enforces commands.allowFrom.qqbot precedence
  // And qqbot: prefix normalization. It is no longer in the pre-dispatch
  // Slash-command registry, so matchSlashCommand returns null and lets the
  // Normal inbound queue handle it.

  it("passes /bot-logs through to the framework (returns null)", async () => {
    const ctx = buildCtx({ commandAuthorized: false, rawContent: "/bot-logs" });
    expect(await matchSlashCommand(ctx)).toBeNull();
  });

  it("passes /bot-logs ? through to the framework (returns null)", async () => {
    const ctx = buildCtx({ commandAuthorized: false, rawContent: "/bot-logs ?" });
    expect(await matchSlashCommand(ctx)).toBeNull();
  });

  // ---- /bot-ping (no requireAuth) ----

  it("allows /bot-ping for unauthorized sender", async () => {
    const ctx = buildCtx({
      commandAuthorized: false,
      rawContent: "/bot-ping",
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("pong");
  });

  it("allows /bot-ping for authorized sender", async () => {
    const ctx = buildCtx({
      commandAuthorized: true,
      rawContent: "/bot-ping",
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("pong");
  });

  // ---- /bot-help (no requireAuth) ----

  it("allows /bot-help for unauthorized sender", async () => {
    const ctx = buildCtx({
      commandAuthorized: false,
      rawContent: "/bot-help",
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("QQBot");
  });

  // ---- /bot-version (no requireAuth) ----

  it("allows /bot-version for unauthorized sender", async () => {
    const ctx = buildCtx({
      commandAuthorized: false,
      rawContent: "/bot-version",
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("OpenClaw");
  });

  // ---- unknown commands ----

  it("returns null for unknown slash commands", async () => {
    const ctx = buildCtx({
      commandAuthorized: false,
      rawContent: "/unknown-command",
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeNull();
  });

  it("returns null for non-slash messages", async () => {
    const ctx = buildCtx({
      commandAuthorized: false,
      rawContent: "hello",
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeNull();
  });

  // ---- usage query (?) for remaining pre-dispatch commands ----
});

describe("/bot-logs framework command hardening", () => {
  function getBotLogsHandler() {
    const command = getFrameworkCommands().find((item) => item.name === "bot-logs");
    expect(command).toBeDefined();
    return command!.handler;
  }

  it("rejects /bot-logs when allowFrom is wildcard", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["*"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("rejects /bot-logs when allowFrom mixes wildcard and explicit entries", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["*", "qqbot:user-1"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("rejects /bot-logs when allowFrom uses qqbot:* wildcard form", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["qqbot:*"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("rejects /bot-logs when allowFrom uses qqbot: * wildcard form", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["qqbot: *"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("allows /bot-logs when allowFrom contains numeric sender ids", async () => {
    const handler = getBotLogsHandler();
    const accountConfig = {
      allowFrom: [12_345],
    } as unknown as SlashCommandContext["accountConfig"];
    const result = await handler(buildCtx({ accountConfig }));
    expect(result).not.toBeNull();
    expect(result).not.toBe(
      "⛔ 权限不足：请先在 channels.qqbot.allowFrom（或对应账号 allowFrom）中配置明确的发送者列表后再使用 /bot-logs。",
    );
  });

  it("allows /bot-logs execution when allowFrom is explicit", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["qqbot:user-1"] } }));
    expect(result).not.toBeNull();
    expect(result).not.toBe(
      "⛔ 权限不足：请先在 channels.qqbot.allowFrom（或对应账号 allowFrom）中配置明确的发送者列表后再使用 /bot-logs。",
    );
  });
});
