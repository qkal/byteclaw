import crypto from "node:crypto";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { monitorTlonProvider } from "./monitor/index.js";
import { tlonSetupWizard } from "./setup-surface.js";
import {
  formatTargetHint,
  normalizeShip,
  parseTlonTarget,
  resolveTlonOutboundTarget,
} from "./targets.js";
import { configureClient } from "./tlon-api.js";
import { resolveTlonAccount } from "./types.js";
import { authenticate } from "./urbit/auth.js";
import { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./urbit/context.js";
import { urbitFetch } from "./urbit/fetch.js";
import {
  buildMediaStory,
  sendDm,
  sendDmWithStory,
  sendGroupMessage,
  sendGroupMessageWithStory,
} from "./urbit/send.js";
import { uploadImageFromUrl } from "./urbit/upload.js";

type ResolvedTlonAccount = ReturnType<typeof resolveTlonAccount>;
type ConfiguredTlonAccount = ResolvedTlonAccount & {
  ship: string;
  url: string;
  code: string;
};

async function createHttpPokeApi(params: {
  url: string;
  code: string;
  ship: string;
  dangerouslyAllowPrivateNetwork?: boolean;
}) {
  const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(
    params.dangerouslyAllowPrivateNetwork,
  );
  const cookie = await authenticate(params.url, params.code, { ssrfPolicy });
  const channelId = `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID()}`;
  const channelPath = `/~/channel/${channelId}`;
  const shipName = params.ship.replace(/^~/, "");

  return {
    delete: async () => {
      // No-op for HTTP-only client
    },
    poke: async (pokeParams: { app: string; mark: string; json: unknown }) => {
      const pokeId = Date.now();
      const pokeData = {
        action: "poke",
        app: pokeParams.app,
        id: pokeId,
        json: pokeParams.json,
        mark: pokeParams.mark,
        ship: shipName,
      };

      const { response, release } = await urbitFetch({
        auditContext: "tlon-poke",
        baseUrl: params.url,
        init: {
          body: JSON.stringify([pokeData]),
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie.split(";")[0],
          },
          method: "PUT",
        },
        path: channelPath,
        ssrfPolicy,
      });

      try {
        if (!response.ok && response.status !== 204) {
          const errorText = await response.text();
          throw new Error(`Poke failed: ${response.status} - ${errorText}`);
        }

        return pokeId;
      } finally {
        await release();
      }
    },
  };
}

function resolveOutboundContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}) {
  const account = resolveTlonAccount(params.cfg, params.accountId ?? undefined);
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured");
  }

  const parsed = parseTlonTarget(params.to);
  if (!parsed) {
    throw new Error(`Invalid Tlon target. Use ${formatTargetHint()}`);
  }

  return { account: account as ConfiguredTlonAccount, parsed };
}

function resolveReplyId(replyToId?: string | null, threadId?: string | number | null) {
  return (replyToId ?? threadId) ? String(replyToId ?? threadId) : undefined;
}

async function withHttpPokeAccountApi<T>(
  account: ConfiguredTlonAccount,
  run: (api: Awaited<ReturnType<typeof createHttpPokeApi>>) => Promise<T>,
) {
  const api = await createHttpPokeApi({
    code: account.code,
    dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? undefined,
    ship: account.ship,
    url: account.url,
  });

  try {
    return await run(api);
  } finally {
    try {
      await api.delete();
    } catch {
      // Ignore cleanup errors
    }
  }
}

export const tlonRuntimeOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  resolveTarget: ({ to }) => resolveTlonOutboundTarget(to),
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
    const { account, parsed } = resolveOutboundContext({ accountId, cfg, to });

    configureClient({
      dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? undefined,
      getCode: async () => account.code,
      shipName: account.ship.replace(/^~/, ""),
      shipUrl: account.url,
      verbose: false,
    });

    const uploadedUrl = mediaUrl ? await uploadImageFromUrl(mediaUrl) : undefined;
    return withHttpPokeAccountApi(account, async (api) => {
      const fromShip = normalizeShip(account.ship);
      const story = buildMediaStory(text, uploadedUrl);

      if (parsed.kind === "dm") {
        return await sendDmWithStory({
          api,
          fromShip,
          story,
          toShip: parsed.ship,
        });
      }
      return await sendGroupMessageWithStory({
        api,
        channelName: parsed.channelName,
        fromShip,
        hostShip: parsed.hostShip,
        replyToId: resolveReplyId(replyToId, threadId),
        story,
      });
    });
  },
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    const { account, parsed } = resolveOutboundContext({ accountId, cfg, to });
    return withHttpPokeAccountApi(account, async (api) => {
      const fromShip = normalizeShip(account.ship);
      if (parsed.kind === "dm") {
        return await sendDm({
          api,
          fromShip,
          text,
          toShip: parsed.ship,
        });
      }
      return await sendGroupMessage({
        api,
        channelName: parsed.channelName,
        fromShip,
        hostShip: parsed.hostShip,
        replyToId: resolveReplyId(replyToId, threadId),
        text,
      });
    });
  },
  textChunkLimit: 10_000,
};

export async function probeTlonAccount(account: ConfiguredTlonAccount) {
  try {
    const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(
      account.dangerouslyAllowPrivateNetwork,
    );
    const cookie = await authenticate(account.url, account.code, { ssrfPolicy });
    const { response, release } = await urbitFetch({
      auditContext: "tlon-probe-account",
      baseUrl: account.url,
      init: {
        headers: { Cookie: cookie },
        method: "GET",
      },
      path: "/~/name",
      ssrfPolicy,
      timeoutMs: 30_000,
    });
    try {
      if (!response.ok) {
        return { error: `Name request failed: ${response.status}`, ok: false };
      }
      return { ok: true };
    } finally {
      await release();
    }
  } catch (error) {
    return { error: (error as { message?: string })?.message ?? String(error), ok: false };
  }
}

export async function startTlonGatewayAccount(
  ctx: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedTlonAccount>["gateway"]>["startAccount"]>
  >[0],
) {
  const { account } = ctx;
  ctx.setStatus({
    accountId: account.accountId,
    ship: account.ship,
    url: account.url,
  } as ChannelAccountSnapshot);
  ctx.log?.info(`[${account.accountId}] starting Tlon provider for ${account.ship ?? "tlon"}`);
  return monitorTlonProvider({
    abortSignal: ctx.abortSignal,
    accountId: account.accountId,
    runtime: ctx.runtime,
  });
}

export { tlonSetupWizard };
