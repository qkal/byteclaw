import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { OpenClawChannelBridge, createOpenClawChannelMcpServer } from "./channel-server.js";

const ClaudeChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});

const ClaudePermissionNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission"),
  params: z.object({
    behavior: z.enum(["allow", "deny"]),
    request_id: z.string(),
  }),
});

async function connectMcpWithoutGateway(params?: { claudeChannelMode?: "auto" | "on" | "off" }) {
  const serverHarness = await createOpenClawChannelMcpServer({
    claudeChannelMode: params?.claudeChannelMode ?? "auto",
    verbose: false,
  });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverHarness.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    bridge: serverHarness.bridge,
    client,
    close: async () => {
      await client.close();
      await serverHarness.close();
    },
  };
}

describe("openclaw channel mcp server", () => {
  describe("gateway-backed flows", () => {
    describe("gateway integration", () => {
      test("lists conversations and reads messages", async () => {
        const sessionKey = "agent:main:main";
        const gatewayRequest = vi.fn(async (method: string) => {
          if (method === "sessions.list") {
            return {
              sessions: [
                {
                  channel: "telegram",
                  deliveryContext: {
                    accountId: "acct-1",
                    threadId: 42,
                    to: "-100123",
                  },
                  key: sessionKey,
                },
              ],
            };
          }
          if (method === "chat.history") {
            return {
              messages: [
                {
                  content: [{ text: "hello from transcript", type: "text" }],
                  role: "assistant",
                },
                {
                  __openclaw: {
                    id: "msg-attachment",
                  },
                  content: [
                    { text: "attached image", type: "text" },
                    {
                      source: {
                        data: "abc",
                        media_type: "image/png",
                        type: "base64",
                      },
                      type: "image",
                    },
                  ],
                  role: "assistant",
                },
              ],
            };
          }
          throw new Error(`unexpected gateway method ${method}`);
        });
        let mcp: Awaited<ReturnType<typeof connectMcpWithoutGateway>> | null = null;
        try {
          mcp = await connectMcpWithoutGateway({
            claudeChannelMode: "off",
          });
          const connectedMcp = mcp;
          (
            connectedMcp.bridge as unknown as {
              gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
              readySettled: boolean;
              resolveReady: () => void;
            }
          ).gateway = {
            request: gatewayRequest,
            stopAndWait: async () => {},
          };
          (
            connectedMcp.bridge as unknown as {
              readySettled: boolean;
              resolveReady: () => void;
            }
          ).readySettled = true;
          (
            connectedMcp.bridge as unknown as {
              resolveReady: () => void;
            }
          ).resolveReady();

          const listed = (await connectedMcp.client.callTool({
            arguments: {},
            name: "conversations_list",
          })) as {
            structuredContent?: { conversations?: Record<string, unknown>[] };
          };
          expect(listed.structuredContent?.conversations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                accountId: "acct-1",
                channel: "telegram",
                sessionKey,
                threadId: 42,
                to: "-100123",
              }),
            ]),
          );

          const read = (await connectedMcp.client.callTool({
            arguments: { limit: 5, session_key: sessionKey },
            name: "messages_read",
          })) as {
            structuredContent?: { messages?: Record<string, unknown>[] };
          };
          expect(read.structuredContent?.messages?.[0]).toMatchObject({
            content: [{ text: "hello from transcript", type: "text" }],
            role: "assistant",
          });
          expect(read.structuredContent?.messages?.[1]).toMatchObject({
            __openclaw: {
              id: "msg-attachment",
            },
          });

          const attachments = (await connectedMcp.client.callTool({
            arguments: { message_id: "msg-attachment", session_key: sessionKey },
            name: "attachments_fetch",
          })) as {
            structuredContent?: { attachments?: Record<string, unknown>[] };
            isError?: boolean;
          };
          expect(attachments.isError).not.toBe(true);
          expect(attachments.structuredContent?.attachments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "image",
              }),
            ]),
          );
        } finally {
          await mcp?.close();
        }
      });

      test("emits Claude channel and permission notifications", async () => {
        const sessionKey = "agent:main:main";
        let mcp: Awaited<ReturnType<typeof connectMcpWithoutGateway>> | null = null;
        try {
          const channelNotifications: { content: string; meta: Record<string, string> }[] = [];
          const permissionNotifications: {
            request_id: string;
            behavior: "allow" | "deny";
          }[] = [];

          mcp = await connectMcpWithoutGateway({
            claudeChannelMode: "on",
          });
          mcp.client.setNotificationHandler(ClaudeChannelNotificationSchema, ({ params }) => {
            channelNotifications.push(params);
          });
          mcp.client.setNotificationHandler(ClaudePermissionNotificationSchema, ({ params }) => {
            permissionNotifications.push(params);
          });

          await (
            mcp.bridge as unknown as {
              handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
            }
          ).handleSessionMessageEvent({
            lastChannel: "imessage",
            lastTo: "+15551234567",
            message: {
              content: [{ text: "hello Claude", type: "text" }],
              role: "user",
              timestamp: Date.now(),
            },
            messageId: "msg-user-1",
            sessionKey,
          });

          await vi.waitFor(() => {
            expect(channelNotifications).toHaveLength(1);
          });
          expect(channelNotifications[0]).toMatchObject({
            content: "hello Claude",
            meta: expect.objectContaining({
              channel: "imessage",
              message_id: "msg-user-1",
              session_key: sessionKey,
              to: "+15551234567",
            }),
          });

          await mcp.client.notification({
            method: "notifications/claude/channel/permission_request",
            params: {
              description: "run npm test",
              input_preview: '{"cmd":"npm test"}',
              request_id: "abcde",
              tool_name: "Bash",
            },
          });

          await (
            mcp.bridge as unknown as {
              handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
            }
          ).handleSessionMessageEvent({
            lastChannel: "imessage",
            lastTo: "+15551234567",
            message: {
              content: [{ text: "yes abcde", type: "text" }],
              role: "user",
              timestamp: Date.now(),
            },
            messageId: "msg-user-2",
            sessionKey,
          });

          await vi.waitFor(() => {
            expect(permissionNotifications).toHaveLength(1);
          });
          expect(permissionNotifications[0]).toEqual({
            behavior: "allow",
            request_id: "abcde",
          });

          await (
            mcp.bridge as unknown as {
              handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
            }
          ).handleSessionMessageEvent({
            lastChannel: "imessage",
            lastTo: "+15551234567",
            message: {
              content: "plain string user turn",
              role: "user",
              timestamp: Date.now(),
            },
            messageId: "msg-user-3",
            sessionKey,
          });

          await vi.waitFor(() => {
            expect(channelNotifications).toHaveLength(2);
          });
          expect(channelNotifications[1]).toMatchObject({
            content: "plain string user turn",
            meta: expect.objectContaining({
              message_id: "msg-user-3",
              session_key: sessionKey,
            }),
          });
        } finally {
          await mcp?.close();
        }
      });
    });

    test("sendMessage normalizes route metadata for gateway send", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "off",
        verbose: false,
      });
      const gatewayRequest = vi.fn().mockResolvedValue({ channel: "telegram", ok: true });

      (
        bridge as unknown as {
          gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).gateway = {
        request: gatewayRequest,
        stopAndWait: async () => {},
      };
      (
        bridge as unknown as {
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).readySettled = true;
      (
        bridge as unknown as {
          resolveReady: () => void;
        }
      ).resolveReady();

      vi.spyOn(bridge, "getConversation").mockResolvedValue({
        accountId: "acct-1",
        channel: "telegram",
        sessionKey: "agent:main:main",
        threadId: 42,
        to: "-100123",
      });

      await bridge.sendMessage({
        sessionKey: "agent:main:main",
        text: "reply from mcp",
      });

      expect(gatewayRequest).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          accountId: "acct-1",
          channel: "telegram",
          message: "reply from mcp",
          sessionKey: "agent:main:main",
          threadId: "42",
          to: "-100123",
        }),
      );
    });

    test("lists routed sessions that only expose modern channel fields", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "off",
        verbose: false,
      });
      const gatewayRequest = vi.fn().mockResolvedValue({
        sessions: [
          {
            channel: "telegram",
            deliveryContext: {
              to: "-100111",
            },
            key: "agent:main:channel-field",
          },
          {
            deliveryContext: {
              to: "+15551230000",
            },
            key: "agent:main:origin-field",
            origin: {
              accountId: "imessage-default",
              provider: "imessage",
              threadId: "thread-7",
            },
          },
        ],
      });

      (
        bridge as unknown as {
          gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).gateway = {
        request: gatewayRequest,
        stopAndWait: async () => {},
      };
      (
        bridge as unknown as {
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).readySettled = true;
      (
        bridge as unknown as {
          resolveReady: () => void;
        }
      ).resolveReady();

      await expect(bridge.listConversations()).resolves.toEqual([
        expect.objectContaining({
          channel: "telegram",
          sessionKey: "agent:main:channel-field",
          to: "-100111",
        }),
        expect.objectContaining({
          accountId: "imessage-default",
          channel: "imessage",
          sessionKey: "agent:main:origin-field",
          threadId: "thread-7",
          to: "+15551230000",
        }),
      ]);
    });

    test("swallows notification send errors after channel replies are matched", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "on",
        verbose: false,
      });

      (
        bridge as unknown as {
          pendingClaudePermissions: Map<string, Record<string, unknown>>;
          server: { server: { notification: ReturnType<typeof vi.fn> } };
        }
      ).pendingClaudePermissions.set("abcde", {
        description: "run npm test",
        inputPreview: '{"cmd":"npm test"}',
        toolName: "Bash",
      });
      (
        bridge as unknown as {
          server: { server: { notification: ReturnType<typeof vi.fn> } };
        }
      ).server = {
        server: {
          notification: vi.fn().mockRejectedValue(new Error("Not connected")),
        },
      };

      await expect(
        (
          bridge as unknown as {
            handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
          }
        ).handleSessionMessageEvent({
          message: {
            content: [{ text: "yes abcde", type: "text" }],
            role: "user",
          },
          sessionKey: "agent:main:main",
        }),
      ).resolves.toBeUndefined();
    });

    test("waits for queued events through the MCP tool", async () => {
      const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
      try {
        await (
          mcp.bridge as unknown as {
            handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
          }
        ).handleSessionMessageEvent({
          lastAccountId: "acct-1",
          lastChannel: "telegram",
          lastThreadId: 42,
          lastTo: "-100123",
          message: {
            content: [{ text: "inbound live message", type: "text" }],
            role: "user",
          },
          messageId: "msg-2",
          messageSeq: 1,
          sessionKey: "agent:main:main",
        });

        const waited = (await mcp.client.callTool({
          arguments: { after_cursor: 0, session_key: "agent:main:main", timeout_ms: 250 },
          name: "events_wait",
        })) as {
          structuredContent?: { event?: Record<string, unknown> };
        };
        expect(waited.structuredContent?.event).toMatchObject({
          messageId: "msg-2",
          role: "user",
          sessionKey: "agent:main:main",
          text: "inbound live message",
          type: "message",
        });
      } finally {
        await mcp.close();
      }
    });
  });
});
