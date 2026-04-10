import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { listSlackMessageActions } from "./message-actions.js";

describe("listSlackMessageActions", () => {
  it("includes file actions when message actions are enabled", () => {
    const cfg = {
      channels: {
        slack: {
          actions: {
            messages: true,
          },
          botToken: "xoxb-test",
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).toEqual(
      expect.arrayContaining(["read", "edit", "delete", "download-file", "upload-file"]),
    );
  });

  it("honors the selected Slack account during discovery", () => {
    const cfg = {
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
              botToken: "xoxb-default",
            },
            work: {
              actions: {
                emojiList: false,
                memberInfo: false,
                messages: true,
                pins: false,
                reactions: true,
              },
              botToken: "xoxb-work",
            },
          },
          actions: {
            emojiList: false,
            memberInfo: false,
            messages: false,
            pins: false,
            reactions: false,
          },
          botToken: "xoxb-root",
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg, "default")).toEqual(["send"]);
    expect(listSlackMessageActions(cfg, "work")).toEqual([
      "send",
      "react",
      "reactions",
      "read",
      "edit",
      "delete",
      "download-file",
      "upload-file",
    ]);
  });
});
