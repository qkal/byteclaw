import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { ChannelOutboundAdapter, ChannelOutboundContext } from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
import { createWhatsAppTestPlugin } from "../infra/outbound/targets.test-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

interface ChannelCase {
  name: string;
  channel: "slack" | "discord" | "whatsapp" | "imessage";
  to: string;
  sendKey: keyof Pick<
    CliDeps,
    "sendMessageSlack" | "sendMessageDiscord" | "sendMessageWhatsApp" | "sendMessageIMessage"
  >;
  expectedTo: string;
}

const CASES: ChannelCase[] = [
  {
    channel: "slack",
    expectedTo: "channel:C12345",
    name: "Slack",
    sendKey: "sendMessageSlack",
    to: "channel:C12345",
  },
  {
    channel: "discord",
    expectedTo: "channel:789",
    name: "Discord",
    sendKey: "sendMessageDiscord",
    to: "channel:789",
  },
  {
    channel: "whatsapp",
    expectedTo: "+15551234567",
    name: "WhatsApp",
    sendKey: "sendMessageWhatsApp",
    to: "+15551234567",
  },
  {
    channel: "imessage",
    expectedTo: "friend@example.com",
    name: "iMessage",
    sendKey: "sendMessageIMessage",
    to: "friend@example.com",
  },
];

async function runExplicitAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  channel: ChannelCase["channel"];
  to: string;
}) {
  return await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath),
    deps: params.deps,
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      delivery: {
        channel: params.channel,
        mode: "announce",
        to: params.to,
      },
    },
    lane: "cron",
    message: "do it",
    sessionKey: "cron:job-1",
  });
}

type CoreChannel = ChannelCase["channel"];
type TestSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId?: string } & Record<string, unknown>>;

function withRequiredMessageId(channel: CoreChannel, result: Awaited<ReturnType<TestSendFn>>) {
  return {
    channel,
    ...result,
    messageId:
      typeof result.messageId === "string" && result.messageId.trim()
        ? result.messageId
        : `${channel}-test-message`,
  };
}

function resolveCoreChannelSender(
  channel: CoreChannel,
  deps: ChannelOutboundContext["deps"],
): TestSendFn {
  const sender = resolveOutboundSendDep<TestSendFn>(deps, channel);
  if (!sender) {
    throw new Error(`missing ${channel} sender`);
  }
  return sender;
}

function createCliDelegatingOutbound(params: {
  channel: CoreChannel;
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
  resolveTarget?: ChannelOutboundAdapter["resolveTarget"];
}): ChannelOutboundAdapter {
  return {
    deliveryMode: params.deliveryMode ?? "direct",
    ...(params.resolveTarget ? { resolveTarget: params.resolveTarget } : {}),
    sendText: async ({ cfg, to, text, accountId, deps }) =>
      withRequiredMessageId(
        params.channel,
        await resolveCoreChannelSender(params.channel, deps)(to, text, {
          accountId: accountId ?? undefined,
          cfg,
        }),
      ),
  };
}

const whatsappResolveTarget = createWhatsAppTestPlugin().outbound?.resolveTarget;

describe("runCronIsolatedAgentTurn core-channel direct delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createOutboundTestPlugin({
            id: "slack",
            outbound: createCliDelegatingOutbound({ channel: "slack" }),
          }),
          pluginId: "slack",
          source: "test",
        },
        {
          plugin: createOutboundTestPlugin({
            id: "discord",
            outbound: createCliDelegatingOutbound({ channel: "discord" }),
          }),
          pluginId: "discord",
          source: "test",
        },
        {
          plugin: createOutboundTestPlugin({
            id: "whatsapp",
            outbound: createCliDelegatingOutbound({
              channel: "whatsapp",
              deliveryMode: "gateway",
              resolveTarget: whatsappResolveTarget,
            }),
          }),
          pluginId: "whatsapp",
          source: "test",
        },
        {
          plugin: createOutboundTestPlugin({
            id: "imessage",
            outbound: createCliDelegatingOutbound({ channel: "imessage" }),
          }),
          pluginId: "imessage",
          source: "test",
        },
      ]),
    );
  });

  for (const testCase of CASES) {
    it(`routes ${testCase.name} text-only announce delivery through the outbound adapter`, async () => {
      await withTempCronHome(async (home) => {
        const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
        const deps = createCliDeps();
        mockAgentPayloads([{ text: "hello from cron" }]);

        const res = await runExplicitAnnounceTurn({
          channel: testCase.channel,
          deps,
          home,
          storePath,
          to: testCase.to,
        });

        expect(res.status).toBe("ok");
        expect(res.delivered).toBe(true);
        expect(res.deliveryAttempted).toBe(true);
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

        const sendFn = deps[testCase.sendKey];
        expect(sendFn).toHaveBeenCalledTimes(1);
        expect(sendFn).toHaveBeenCalledWith(
          testCase.expectedTo,
          "hello from cron",
          expect.any(Object),
        );
      });
    });

    it(`preserves multi-payload text-only announce delivery for ${testCase.name} even when final assistant text exists`, async () => {
      await withTempCronHome(async (home) => {
        const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
        const deps = createCliDeps();
        mockAgentPayloads([{ text: "Working on it..." }, { text: "Final weather summary" }], {
          meta: {
            agentMeta: { model: "m", provider: "p", sessionId: "s" },
            durationMs: 5,
            finalAssistantVisibleText: "Final weather summary",
          },
        });

        const res = await runExplicitAnnounceTurn({
          channel: testCase.channel,
          deps,
          home,
          storePath,
          to: testCase.to,
        });

        expect(res.status).toBe("ok");
        expect(res.delivered).toBe(true);
        expect(res.deliveryAttempted).toBe(true);
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

        const sendFn = deps[testCase.sendKey];
        expect(sendFn).toHaveBeenCalledTimes(2);
        expect(sendFn).toHaveBeenNthCalledWith(
          1,
          testCase.expectedTo,
          "Working on it...",
          expect.any(Object),
        );
        expect(sendFn).toHaveBeenNthCalledWith(
          2,
          testCase.expectedTo,
          "Final weather summary",
          expect.any(Object),
        );
      });
    });
  }
});
