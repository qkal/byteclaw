import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveIrcAccount } from "./accounts.js";
import { type IrcClient, connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { handleIrcInbound } from "./inbound.js";
import { isChannelTarget } from "./normalize.js";
import { makeIrcMessageId } from "./protocol.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

export interface IrcMonitorOptions {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  onMessage?: (message: IrcInboundMessage, client: IrcClient) => void | Promise<void>;
}

export function resolveIrcInboundTarget(params: { target: string; senderNick: string }): {
  isGroup: boolean;
  target: string;
  rawTarget: string;
} {
  const rawTarget = params.target;
  const isGroup = isChannelTarget(rawTarget);
  if (isGroup) {
    return { isGroup: true, rawTarget, target: rawTarget };
  }
  const senderNick = params.senderNick.trim();
  return { isGroup: false, rawTarget, target: senderNick || rawTarget };
}

export async function monitorIrcProvider(opts: IrcMonitorOptions): Promise<{ stop: () => void }> {
  const core = getIrcRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveIrcAccount({
    accountId: opts.accountId,
    cfg,
  });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }

  const logger = core.logging.getChildLogger({
    accountId: account.accountId,
    channel: "irc",
  });

  let client: IrcClient | null = null;

  client = await connectIrcClient(
    buildIrcConnectOptions(account, {
      abortSignal: opts.abortSignal,
      channels: account.config.channels,
      onError: (error) => {
        logger.error(`[${account.accountId}] IRC error: ${error.message}`);
      },
      onLine: (line) => {
        if (core.logging.shouldLogVerbose()) {
          logger.debug?.(`[${account.accountId}] << ${line}`);
        }
      },
      onNotice: (text, target) => {
        if (core.logging.shouldLogVerbose()) {
          logger.debug?.(`[${account.accountId}] notice ${target ?? ""}: ${text}`);
        }
      },
      onPrivmsg: async (event) => {
        if (!client) {
          return;
        }
        if (
          normalizeLowercaseStringOrEmpty(event.senderNick) ===
          normalizeLowercaseStringOrEmpty(client.nick)
        ) {
          return;
        }

        const inboundTarget = resolveIrcInboundTarget({
          senderNick: event.senderNick,
          target: event.target,
        });
        const message: IrcInboundMessage = {
          isGroup: inboundTarget.isGroup,
          messageId: makeIrcMessageId(),
          rawTarget: inboundTarget.rawTarget,
          senderHost: event.senderHost,
          senderNick: event.senderNick,
          senderUser: event.senderUser,
          target: inboundTarget.target,
          text: event.text,
          timestamp: Date.now(),
        };

        core.channel.activity.record({
          accountId: account.accountId,
          at: message.timestamp,
          channel: "irc",
          direction: "inbound",
        });

        if (opts.onMessage) {
          await opts.onMessage(message, client);
          return;
        }

        await handleIrcInbound({
          account,
          config: cfg,
          connectedNick: client.nick,
          message,
          runtime,
          sendReply: async (target, text) => {
            client?.sendPrivmsg(target, text);
            opts.statusSink?.({ lastOutboundAt: Date.now() });
            core.channel.activity.record({
              channel: "irc",
              accountId: account.accountId,
              direction: "outbound",
            });
          },
          statusSink: opts.statusSink,
        });
      },
    }),
  );

  logger.info(
    `[${account.accountId}] connected to ${account.host}:${account.port}${account.tls ? " (tls)" : ""} as ${client.nick}`,
  );

  return {
    stop: () => {
      client?.quit("shutdown");
      client = null;
    },
  };
}
