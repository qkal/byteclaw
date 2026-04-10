import type { ButtonInteraction, ComponentData } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApprovalOverGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/approval-gateway-runtime")>();
  return {
    ...actual,
    resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
  };
});

import {
  ExecApprovalButton,
  buildExecApprovalCustomId,
  createDiscordExecApprovalButtonContext,
  extractDiscordChannelId,
  parseExecApprovalData,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>["execApprovals"],
): OpenClawConfig {
  return {
    channels: {
      discord: {
        execApprovals,
        token: "discord-token",
      },
    },
  } as OpenClawConfig;
}

function createInteraction(overrides?: Partial<ButtonInteraction>): ButtonInteraction {
  return {
    acknowledge: vi.fn(),
    followUp: vi.fn(),
    reply: vi.fn(),
    userId: "123",
    ...overrides,
  } as unknown as ButtonInteraction;
}

describe("discord exec approval monitor helpers", () => {
  beforeEach(() => {
    resolveApprovalOverGatewayMock.mockReset();
  });

  it("encodes approval ids into custom ids", () => {
    expect(buildExecApprovalCustomId("abc-123", "allow-once")).toBe(
      "execapproval:id=abc-123;action=allow-once",
    );
    expect(buildExecApprovalCustomId("abc=123;test", "deny")).toBe(
      "execapproval:id=abc%3D123%3Btest;action=deny",
    );
  });

  it("parses valid button data and rejects invalid payloads", () => {
    expect(parseExecApprovalData({ action: "allow-once", id: "abc-123" })).toEqual({
      action: "allow-once",
      approvalId: "abc-123",
    });
    expect(
      parseExecApprovalData({
        action: "allow-always",
        id: "abc%3D123%3Btest",
      }),
    ).toEqual({
      action: "allow-always",
      approvalId: "abc=123;test",
    });
    expect(parseExecApprovalData({ action: "invalid", id: "abc" })).toBeNull();
    expect(parseExecApprovalData({ action: "deny" } as ComponentData)).toBeNull();
  });

  it("extracts discord channel ids from session keys", () => {
    expect(extractDiscordChannelId("agent:main:discord:channel:123456789")).toBe("123456789");
    expect(extractDiscordChannelId("agent:main:discord:group:222333444")).toBe("222333444");
    expect(extractDiscordChannelId("agent:main:telegram:channel:123456789")).toBeNull();
    expect(extractDiscordChannelId("")).toBeNull();
  });

  it("rejects invalid approval button payloads", async () => {
    const interaction = createInteraction();
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => true,
    });

    await button.run(interaction, { action: "", id: "" });

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This approval is no longer valid.",
      ephemeral: true,
    });
  });

  it("blocks non-approvers from approving", async () => {
    const interaction = createInteraction({ userId: "999" });
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => true,
    });

    await button.run(interaction, { action: "allow-once", id: "abc" });

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "⛔ You are not authorized to approve exec requests.",
      ephemeral: true,
    });
  });

  it("acknowledges and resolves valid approval clicks", async () => {
    const interaction = createInteraction();
    const resolveApproval = vi.fn(async () => true);
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval,
    });

    await button.run(interaction, { action: "allow-once", id: "abc" });

    expect(interaction.acknowledge).toHaveBeenCalled();
    expect(resolveApproval).toHaveBeenCalledWith("abc", "allow-once");
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("shows a follow-up when gateway resolution fails", async () => {
    const interaction = createInteraction();
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => false,
    });

    await button.run(interaction, { action: "deny", id: "abc" });

    expect(interaction.followUp).toHaveBeenCalledWith({
      content:
        "Failed to submit approval decision for **Denied**. The request may have expired or already been resolved.",
      ephemeral: true,
    });
  });

  it("builds button context from config and routes resolution over gateway", async () => {
    const cfg = buildConfig({ approvers: ["123"], enabled: true });
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
    const ctx = createDiscordExecApprovalButtonContext({
      accountId: "default",
      cfg,
      config: { approvers: ["123"], enabled: true },
      gatewayUrl: "ws://127.0.0.1:18789",
    });

    expect(ctx.getApprovers()).toEqual(["123"]);
    await expect(ctx.resolveApproval("abc", "allow-once")).resolves.toBe(true);
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      approvalId: "abc",
      cfg,
      clientDisplayName: "Discord approval (default)",
      decision: "allow-once",
      gatewayUrl: "ws://127.0.0.1:18789",
    });
  });

  it("returns false when gateway resolution throws", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValue(new Error("boom"));
    const ctx = createDiscordExecApprovalButtonContext({
      accountId: "default",
      cfg: buildConfig({ approvers: ["123"], enabled: true }),
      config: { approvers: ["123"], enabled: true },
    });

    await expect(ctx.resolveApproval("abc", "allow-once")).resolves.toBe(false);
  });
});
