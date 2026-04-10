import { describe, expect, it } from "vitest";
import {
  buildApprovalPendingReplyPayload,
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
} from "./approval-renderers.js";

describe("plugin-sdk/approval-renderers", () => {
  it.each([
    {
      channelDataExpected: undefined,
      interactiveExpected: {
        blocks: [
          {
            buttons: [
              {
                label: "Allow Once",
                value: "/approve plugin:approval-123 allow-once",
                style: "success",
              },
              {
                label: "Allow Always",
                value: "/approve plugin:approval-123 allow-always",
                style: "primary",
              },
              {
                label: "Deny",
                value: "/approve plugin:approval-123 deny",
                style: "danger",
              },
            ],
            type: "buttons",
          },
        ],
      },
      name: "builds shared approval payloads with generic interactive commands",
      payload: buildApprovalPendingReplyPayload({
        approvalId: "plugin:approval-123",
        approvalSlug: "plugin:a",
        text: "Approval required @everyone",
      }),
      textExpected: (text: string) => expect(text).toContain("@everyone"),
    },
    {
      channelDataExpected: {
        execApproval: {
          agentId: undefined,
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          approvalId: "plugin-approval-123",
          approvalKind: "plugin",
          approvalSlug: "custom-slug",
          sessionKey: undefined,
          state: "pending",
        },
        telegram: {
          quoteText: "quoted",
        },
      },
      interactiveExpected: {
        blocks: [
          {
            buttons: [
              {
                label: "Allow Once",
                value: "/approve plugin-approval-123 allow-once",
                style: "success",
              },
              {
                label: "Allow Always",
                value: "/approve plugin-approval-123 allow-always",
                style: "primary",
              },
              {
                label: "Deny",
                value: "/approve plugin-approval-123 deny",
                style: "danger",
              },
            ],
            type: "buttons",
          },
        ],
      },
      name: "builds plugin pending payloads with approval metadata and extra channel data",
      payload: buildPluginApprovalPendingReplyPayload({
        approvalSlug: "custom-slug",
        channelData: {
          telegram: {
            quoteText: "quoted",
          },
        },
        nowMs: 1_000,
        request: {
          createdAtMs: 1_000,
          expiresAtMs: 61_000,
          id: "plugin-approval-123",
          request: {
            description: "Needs approval",
            title: "Sensitive action",
          },
        },
      }),
      textExpected: (text: string) => expect(text).toContain("Plugin approval required"),
    },
    {
      channelDataExpected: {
        execApproval: {
          approvalId: "req-123",
          approvalSlug: "req-123",
          state: "resolved",
        },
      },
      interactiveExpected: undefined,
      name: "builds generic resolved payloads with approval metadata",
      payload: buildApprovalResolvedReplyPayload({
        approvalId: "req-123",
        approvalSlug: "req-123",
        text: "resolved @everyone",
      }),
      textExpected: (text: string) => expect(text).toBe("resolved @everyone"),
    },
    {
      channelDataExpected: {
        discord: {
          components: [{ type: "container" }],
        },
        execApproval: {
          approvalId: "plugin-approval-123",
          approvalSlug: "plugin-a",
          state: "resolved",
        },
      },
      interactiveExpected: undefined,
      name: "builds plugin resolved payloads with optional channel data",
      payload: buildPluginApprovalResolvedReplyPayload({
        channelData: {
          discord: {
            components: [{ type: "container" }],
          },
        },
        resolved: {
          decision: "allow-once",
          id: "plugin-approval-123",
          resolvedBy: "discord:user:1",
          ts: 2_000,
        },
      }),
      textExpected: (text: string) => expect(text).toContain("Plugin approval allowed once"),
    },
  ])("$name", ({ payload, textExpected, interactiveExpected, channelDataExpected }) => {
    expect(payload.text).toBeDefined();
    if (payload.text !== undefined) {
      textExpected(payload.text);
    }
    if (interactiveExpected) {
      expect(payload.interactive).toEqual(interactiveExpected);
    }
    if (channelDataExpected) {
      expect(payload.channelData).toEqual(channelDataExpected);
    }
  });
});
