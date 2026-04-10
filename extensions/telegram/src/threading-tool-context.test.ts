import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";

describe("buildTelegramThreadingToolContext", () => {
  it("keeps topic thread state in plugin-owned tool context", () => {
    expect(
      buildTelegramThreadingToolContext({
        accountId: "default",
        cfg: {} as OpenClawConfig,
        context: {
          CurrentMessageId: "msg-1",
          MessageThreadId: 77,
          To: "telegram:-1001:topic:77",
        },
        hasRepliedRef: { value: false },
      }),
    ).toMatchObject({
      currentChannelId: "telegram:-1001:topic:77",
      currentThreadTs: "77",
    });
  });

  it("parses topic thread state from target grammar when MessageThreadId is absent", () => {
    expect(
      buildTelegramThreadingToolContext({
        accountId: "default",
        cfg: {} as OpenClawConfig,
        context: {
          CurrentMessageId: "msg-1",
          To: "telegram:-1001:topic:77",
        },
      }),
    ).toMatchObject({
      currentChannelId: "telegram:-1001:topic:77",
      currentThreadTs: "77",
    });
  });
});
