import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import { slackPlugin } from "./channel.js";
import { slackOutbound } from "./outbound-adapter.js";
import * as probeModule from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { clearSlackRuntime, setSlackRuntime } from "./runtime.js";

const { handleSlackActionMock } = vi.hoisted(() => ({
  handleSlackActionMock: vi.fn(),
}));
const { sendMessageSlackMock } = vi.hoisted(() => ({
  sendMessageSlackMock: vi.fn(),
}));

vi.mock("./action-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./action-runtime.js")>("./action-runtime.js");
  return {
    ...actual,
    handleSlackAction: handleSlackActionMock,
  };
});

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

beforeEach(async () => {
  handleSlackActionMock.mockReset();
  sendMessageSlackMock.mockReset();
  sendMessageSlackMock.mockResolvedValue({ channelId: "D123", messageId: "msg-1" });
  setSlackRuntime({
    channel: {
      slack: {
        handleSlackAction: handleSlackActionMock,
      },
    },
  } as never);
});

async function getSlackConfiguredState(cfg: OpenClawConfig) {
  const account = slackPlugin.config.resolveAccount(cfg, "default");
  return {
    configured: slackPlugin.config.isConfigured?.(account, cfg),
    snapshot: await slackPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: undefined,
    }),
  };
}

function requireSlackHandleAction() {
  const handleAction = slackPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("slack actions.handleAction unavailable");
  }
  return handleAction;
}

function requireSlackSendText() {
  const sendText = slackPlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("slack outbound.sendText unavailable");
  }
  return sendText;
}

function requireSlackSendMedia() {
  const sendMedia = slackPlugin.outbound?.sendMedia;
  if (!sendMedia) {
    throw new Error("slack outbound.sendMedia unavailable");
  }
  return sendMedia;
}

function requireSlackSendPayload() {
  const sendPayload = slackPlugin.outbound?.sendPayload ?? slackOutbound.sendPayload;
  if (!sendPayload) {
    throw new Error("slack outbound.sendPayload unavailable");
  }
  return sendPayload;
}

function requireSlackListPeers() {
  const listPeers = slackPlugin.directory?.listPeers;
  if (!listPeers) {
    throw new Error("slack directory.listPeers unavailable");
  }
  return listPeers;
}

describe("slackPlugin actions", () => {
  it("prefers session lookup for announce target routing", () => {
    expect(slackPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });

  it("owns unified message tool discovery", () => {
    const discovery = slackPlugin.actions?.describeMessageTool({
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-test",
            botToken: "xoxb-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.capabilities).toEqual(expect.arrayContaining(["blocks", "interactive"]));
    expect(discovery?.schema).toMatchObject({
      properties: {
        blocks: expect.any(Object),
      },
    });
  });

  it("honors the selected Slack account during message tool discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          accounts: {
            default: {
              actions: {
                emojiList: false,
                memberInfo: false,
                messages: false,
                pins: false,
                reactions: false,
              },
              appToken: "xapp-default",
              botToken: "xoxb-default",
              capabilities: {
                interactiveReplies: false,
              },
            },
            work: {
              actions: {
                emojiList: false,
                memberInfo: false,
                messages: true,
                pins: false,
                reactions: true,
              },
              appToken: "xapp-work",
              botToken: "xoxb-work",
              capabilities: {
                interactiveReplies: true,
              },
            },
          },
          actions: {
            emojiList: false,
            memberInfo: false,
            messages: false,
            pins: false,
            reactions: false,
          },
          appToken: "xapp-root",
          botToken: "xoxb-root",
          capabilities: {
            interactiveReplies: false,
          },
        },
      },
    };

    expect(slackPlugin.actions?.describeMessageTool?.({ accountId: "default", cfg })).toMatchObject(
      {
        actions: ["send"],
        capabilities: ["blocks"],
      },
    );
    expect(slackPlugin.actions?.describeMessageTool?.({ accountId: "work", cfg })).toMatchObject({
      actions: [
        "send",
        "react",
        "reactions",
        "read",
        "edit",
        "delete",
        "download-file",
        "upload-file",
      ],
      capabilities: expect.arrayContaining(["blocks", "interactive"]),
    });
  });

  it("uses configured defaultAccount for pairing approval notifications", async () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            work: {
              botToken: "xoxb-work",
            },
          },
          defaultAccount: "work",
        },
      },
    } as OpenClawConfig;
    setSlackRuntime({
      config: {
        loadConfig: () => cfg,
      },
    } as never);

    const notify = slackPlugin.pairing?.notifyApproval;
    if (!notify) {
      throw new Error("slack pairing notify unavailable");
    }

    await notify({
      cfg,
      id: "U12345678",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "user:U12345678",
      expect.stringContaining("approved"),
    );
  });

  it("keeps blocks optional in the message tool schema", () => {
    const discovery = slackPlugin.actions?.describeMessageTool({
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-test",
            botToken: "xoxb-test",
          },
        },
      } as OpenClawConfig,
    });
    const schema = discovery?.schema;
    if (!schema || Array.isArray(schema)) {
      throw new Error("expected slack message-tool schema");
    }

    expect(Type.Object(schema.properties).required).toBeUndefined();
  });

  it("treats interactive reply payloads as structured Slack payloads", () => {
    const hasStructuredReplyPayload = slackPlugin.messaging?.hasStructuredReplyPayload;
    if (!hasStructuredReplyPayload) {
      throw new Error("slack messaging.hasStructuredReplyPayload unavailable");
    }

    expect(
      hasStructuredReplyPayload({
        payload: {
          interactive: {
            blocks: [{ buttons: [{ label: "Retry", value: "retry" }], type: "buttons" }],
          },
          text: "Choose",
        },
      }),
    ).toBe(true);
  });

  it("forwards read threadId to Slack action handler", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ hasMore: false, messages: [] });
    const handleAction = requireSlackHandleAction();

    await handleAction({
      accountId: "default",
      action: "read",
      cfg: {},
      channel: "slack",
      params: {
        channelId: "C123",
        threadId: "1712345678.123456",
      },
    });

    expect(handleSlackActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "readMessages",
        channelId: "C123",
        threadId: "1712345678.123456",
      }),
      {},
      undefined,
    );
  });
});

describe("slackPlugin status", () => {
  it("uses the direct Slack probe helper when runtime is not initialized", async () => {
    const probeSpy = vi.spyOn(probeModule, "probeSlack").mockResolvedValueOnce({
      bot: { id: "B1", name: "openclaw-bot" },
      ok: true,
      status: 200,
      team: { id: "T1", name: "OpenClaw" },
    });
    clearSlackRuntime();
    const cfg = {
      channels: {
        slack: {
          appToken: "xapp-test",
          botToken: "xoxb-test",
        },
      },
    } as OpenClawConfig;
    const account = slackPlugin.config.resolveAccount(cfg, "default");

    const result = await slackPlugin.status!.probeAccount!({
      account,
      cfg,
      timeoutMs: 2500,
    });

    expect(probeSpy).toHaveBeenCalledWith("xoxb-test", 2500);
    expect(result).toEqual({
      bot: { id: "B1", name: "openclaw-bot" },
      ok: true,
      status: 200,
      team: { id: "T1", name: "OpenClaw" },
    });
  });
});

describe("slackPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes", () => {
    const resolveDmPolicy = slackPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const result = resolveDmPolicy({
      account: slackPlugin.config.resolveAccount(
        {
          channels: {
            slack: {
              appToken: "xapp-test",
              botToken: "xoxb-test",
              dm: { allowFrom: ["  slack:U123  "], policy: "allowlist" },
            },
          },
        } as OpenClawConfig,
        "default",
      ),
      cfg: {
        channels: {
          slack: {
            dm: { allowFrom: ["  slack:U123  "], policy: "allowlist" },
          },
        },
      } as OpenClawConfig,
    });
    if (!result) {
      throw new Error("slack resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  slack:U123  "]);
    expect(result.normalizeEntry?.("  slack:U123  ")).toBe("U123");
    expect(result.normalizeEntry?.("  user:U999  ")).toBe("U999");
  });
});

describe("slackPlugin outbound", () => {
  const cfg = {
    channels: {
      slack: {
        appToken: "xapp-test",
        botToken: "xoxb-test",
      },
    },
  };

  it("treats ACP block text as visible delivered output", () => {
    expect(
      slackPlugin.outbound?.shouldTreatDeliveredTextAsVisible?.({
        kind: "block",
        text: "hello",
      }),
    ).toBe(true);
    expect(
      slackPlugin.outbound?.shouldTreatDeliveredTextAsVisible?.({
        kind: "tool",
        text: "hello",
      }),
    ).toBe(false);
  });

  it("advertises the 8000-character Slack default chunk limit", () => {
    expect(slackOutbound.textChunkLimit).toBe(8000);
    expect(slackPlugin.outbound?.textChunkLimit).toBe(8000);
  });

  it("uses threadId as threadTs fallback for sendText", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      text: "hello",
      threadId: "1712345678.123456",
      to: "C123",
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C123",
      "hello",
      expect.objectContaining({
        threadTs: "1712345678.123456",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-text" });
  });

  it("prefers replyToId over threadId for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media" });
    const sendMedia = requireSlackSendMedia();

    const result = await sendMedia({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      mediaUrl: "https://example.com/image.png",
      replyToId: "1712000000.000001",
      text: "caption",
      threadId: "1712345678.123456",
      to: "C999",
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C999",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/image.png",
        threadTs: "1712000000.000001",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-media" });
  });

  it("forwards mediaLocalRoots for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media-local" });
    const sendMedia = requireSlackSendMedia();
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await sendMedia({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      mediaLocalRoots,
      mediaUrl: "/tmp/workspace/image.png",
      text: "caption",
      to: "C999",
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C999",
      "caption",
      expect.objectContaining({
        mediaLocalRoots,
        mediaUrl: "/tmp/workspace/image.png",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-media-local" });
  });

  it("sends block payload media first, then the final block message", async () => {
    const sendSlack = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });
    const sendPayload = requireSlackSendPayload();

    const result = await sendPayload({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      mediaLocalRoots: ["/tmp/media"],
      payload: {
        channelData: {
          slack: {
            blocks: [
              {
                text: {
                  text: "Block body",
                  type: "plain_text",
                },
                type: "section",
              },
            ],
          },
        },
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        text: "hello",
      },
      text: "",
      to: "C999",
    });

    expect(sendSlack).toHaveBeenCalledTimes(3);
    expect(sendSlack).toHaveBeenNthCalledWith(
      1,
      "C999",
      "",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/media"],
        mediaUrl: "https://example.com/1.png",
      }),
    );
    expect(sendSlack).toHaveBeenNthCalledWith(
      2,
      "C999",
      "",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/media"],
        mediaUrl: "https://example.com/2.png",
      }),
    );
    expect(sendSlack).toHaveBeenNthCalledWith(
      3,
      "C999",
      "hello",
      expect.objectContaining({
        blocks: [
          {
            text: {
              text: "Block body",
              type: "plain_text",
            },
            type: "section",
          },
        ],
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });

  it("renders shared interactive payloads into Slack Block Kit via plugin outbound", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-interactive" });
    const sendPayload = requireSlackSendPayload();

    const result = await sendPayload({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      payload: {
        interactive: {
          blocks: [
            {
              text: "Slack interactive smoke.",
              type: "text",
            },
            {
              buttons: [
                { label: "Approve", value: "approve" },
                { label: "Reject", value: "reject" },
              ],
              type: "buttons",
            },
            {
              options: [
                { label: "Canary", value: "canary" },
                { label: "Production", value: "production" },
              ],
              placeholder: "Choose a target",
              type: "select",
            },
          ],
        },
        text: "Slack interactive smoke.",
      },
      text: "",
      to: "user:U123",
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "user:U123",
      "Slack interactive smoke.",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "section",
          }),
          expect.objectContaining({
            elements: [
              expect.objectContaining({ type: "button", value: "approve" }),
              expect.objectContaining({ type: "button", value: "reject" }),
            ],
            type: "actions",
          }),
          expect.objectContaining({
            elements: [
              expect.objectContaining({
                options: [
                  expect.objectContaining({ value: "canary" }),
                  expect.objectContaining({ value: "production" }),
                ],
                type: "static_select",
              }),
            ],
            type: "actions",
          }),
        ],
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-interactive" });
  });
});

describe("slackPlugin directory", () => {
  it("lists configured peers without throwing a ReferenceError", async () => {
    const listPeers = requireSlackListPeers();

    await expect(
      listPeers({
        cfg: {
          channels: {
            slack: {
              dms: {
                U123: {},
              },
            },
          },
        },
        runtime: createRuntimeEnv(),
      }),
    ).resolves.toEqual([{ id: "user:u123", kind: "user" }]);
  });
});

describe("slackPlugin agentPrompt", () => {
  it("tells agents interactive replies are disabled by default", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-test",
            botToken: "xoxb-test",
          },
        },
      },
    });

    expect(hints).toEqual([
      "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
    ]);
  });

  it("shows Slack interactive reply directives when enabled", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-test",
            botToken: "xoxb-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(hints).toContain(
      "- Prefer Slack buttons/selects for 2-5 discrete choices or parameter picks instead of asking the user to type one.",
    );
    expect(hints).toContain(
      "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
    );
    expect(hints).toContain(
      "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
    );
  });
});

describe("slackPlugin outbound new targets", () => {
  const cfg = {
    channels: {
      slack: {
        appToken: "xapp-test",
        botToken: "xoxb-test",
      },
    },
  };

  it("sends to a new user target via DM without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ channelId: "D999", messageId: "m-new-user" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      text: "hello new user",
      to: "user:U99NEW",
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "user:U99NEW",
      "hello new user",
      expect.objectContaining({ cfg }),
    );
    expect(result).toEqual({ channel: "slack", channelId: "D999", messageId: "m-new-user" });
  });

  it("sends to a new channel target without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ channelId: "C555", messageId: "m-new-chan" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      text: "hello channel",
      to: "channel:C555NEW",
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "channel:C555NEW",
      "hello channel",
      expect.objectContaining({ cfg }),
    );
    expect(result).toEqual({ channel: "slack", channelId: "C555", messageId: "m-new-chan" });
  });

  it("sends media to a new user target without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ channelId: "D888", messageId: "m-new-media" });
    const sendMedia = requireSlackSendMedia();

    const result = await sendMedia({
      accountId: "default",
      cfg,
      deps: { sendSlack },
      mediaUrl: "https://example.com/file.png",
      text: "here is a file",
      to: "user:U88NEW",
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "user:U88NEW",
      "here is a file",
      expect.objectContaining({
        cfg,
        mediaUrl: "https://example.com/file.png",
      }),
    );
    expect(result).toEqual({ channel: "slack", channelId: "D888", messageId: "m-new-media" });
  });
});

describe("slackPlugin config", () => {
  it("treats HTTP mode accounts with bot token + signing secret as configured", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          botToken: "xoxb-http",
          mode: "http",
          signingSecret: "secret-http", // Pragma: allowlist secret
        },
      },
    };

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

    expect(configured).toBe(true);
    expect(snapshot?.configured).toBe(true);
  });

  it("keeps socket mode requiring app token", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          botToken: "xoxb-socket",
          mode: "socket",
        },
      },
    };

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

    expect(configured).toBe(false);
    expect(snapshot?.configured).toBe(false);
  });

  it("does not mark partial configured-unavailable token status as configured", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        appTokenSource: "none",
        appTokenStatus: "missing",
        botTokenSource: "config",
        botTokenStatus: "configured_unavailable",
        config: {},
        configured: false,
        enabled: true,
        name: "Default",
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(snapshot?.botTokenStatus).toBe("configured_unavailable");
    expect(snapshot?.appTokenStatus).toBe("missing");
  });

  it("keeps HTTP mode signing-secret unavailable accounts configured in snapshots", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: true,
        mode: "http",
        botTokenStatus: "available",
        signingSecretStatus: "configured_unavailable", // Pragma: allowlist secret
        botTokenSource: "config",
        signingSecretSource: "config", // Pragma: allowlist secret
        config: {
          botToken: "xoxb-http",
          mode: "http",
          signingSecret: { id: "SLACK_SIGNING_SECRET", provider: "default", source: "env" },
        },
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(true);
    expect(snapshot?.botTokenStatus).toBe("available");
    expect(snapshot?.signingSecretStatus).toBe("configured_unavailable");
  });
});
