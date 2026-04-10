import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackChannelConfigEntries } from "../channel-config.js";
import { createSlackMonitorContext } from "../context.js";

export function createInboundSlackTestContext(params: {
  cfg: OpenClawConfig;
  appClient?: App["client"];
  defaultRequireMention?: boolean;
  replyToMode?: "off" | "all" | "first";
  channelsConfig?: SlackChannelConfigEntries;
  threadRequireExplicitMention?: boolean;
}) {
  return createSlackMonitorContext({
    accountId: "default",
    ackReactionScope: "group-mentions",
    allowFrom: [],
    allowNameMatching: false,
    apiAppId: "A1",
    app: { client: params.appClient ?? {} } as App,
    botToken: "token",
    botUserId: "B1",
    cfg: params.cfg,
    channelsConfig: params.channelsConfig,
    defaultRequireMention: params.defaultRequireMention ?? true,
    dmEnabled: true,
    dmPolicy: "open",
    groupDmChannels: [],
    groupDmEnabled: true,
    groupPolicy: "open",
    historyLimit: 0,
    mainKey: "main",
    mediaMaxBytes: 1024,
    reactionAllowlist: [],
    reactionMode: "off",
    removeAckAfterReply: false,
    replyToMode: params.replyToMode ?? "off",
    runtime: {} as RuntimeEnv,
    sessionScope: "per-sender",
    slashCommand: {
      enabled: false,
      ephemeral: true,
      name: "openclaw",
      sessionPrefix: "slack:slash",
    },
    teamId: "T1",
    textLimit: 4000,
    threadHistoryScope: "thread",
    threadInheritParent: false,
    threadRequireExplicitMention: params.threadRequireExplicitMention ?? false,
    typingReaction: "",
    useAccessGroups: false,
  });
}

export function createSlackTestAccount(
  config: ResolvedSlackAccount["config"] = {},
): ResolvedSlackAccount {
  return {
    accountId: "default",
    appTokenSource: "config",
    botTokenSource: "config",
    config,
    dm: config.dm,
    enabled: true,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    userTokenSource: "none",
  };
}
