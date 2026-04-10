import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createAsyncComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  type ResolvedZalouserAccount,
  checkZcaAuthenticated,
  resolveZalouserAccountSync,
} from "./accounts.js";
import type { ChannelDirectoryEntry, ChannelPlugin } from "./channel-api.js";
import { DEFAULT_ACCOUNT_ID } from "./channel-api.js";
import {
  resolveZalouserQrProfile,
  zalouserAuthAdapter,
  zalouserGroupsAdapter,
  zalouserMessageActions,
  zalouserMessagingAdapter,
  zalouserOutboundAdapter,
  zalouserPairingTextAdapter,
  zalouserResolverAdapter,
  zalouserSecurityAdapter,
  zalouserThreadingAdapter,
} from "./channel.adapters.js";
import { listZalouserDirectoryGroupMembers } from "./directory.js";
import type { ZalouserProbeResult } from "./probe.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { createZalouserPluginBase } from "./shared.js";
import { collectZalouserStatusIssues } from "./status-issues.js";

const loadZalouserChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

function mapUser(params: {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    avatarUrl: params.avatarUrl ?? undefined,
    id: params.id,
    kind: "user",
    name: params.name ?? undefined,
    raw: params.raw,
  };
}

function mapGroup(params: {
  id: string;
  name?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    id: params.id,
    kind: "group",
    name: params.name ?? undefined,
    raw: params.raw,
  };
}

export const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult> =
  createChatChannelPlugin({
    base: {
      ...createZalouserPluginBase({
        setup: zalouserSetupAdapter,
        setupWizard: zalouserSetupWizard,
      }),
      actions: zalouserMessageActions,
      auth: zalouserAuthAdapter,
      directory: {
        listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
          const { listZaloGroupMembers } = await loadZalouserChannelRuntime();
          return await listZalouserDirectoryGroupMembers(
            {
              accountId: accountId ?? undefined,
              cfg,
              groupId,
              limit: limit ?? undefined,
            },
            { listZaloGroupMembers },
          );
        },
        listGroups: async ({ cfg, accountId, query, limit }) => {
          const { listZaloGroupsMatching } = await loadZalouserChannelRuntime();
          const account = resolveZalouserAccountSync({ cfg, accountId });
          const groups = await listZaloGroupsMatching(account.profile, query);
          const rows = groups.map((group) =>
            mapGroup({
              id: `group:${String(group.groupId)}`,
              name: group.name ?? null,
              raw: group,
            }),
          );
          return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
        },
        listPeers: async ({ cfg, accountId, query, limit }) => {
          const { listZaloFriendsMatching } = await loadZalouserChannelRuntime();
          const account = resolveZalouserAccountSync({ cfg, accountId });
          const friends = await listZaloFriendsMatching(account.profile, query);
          const rows = friends.map((friend) =>
            mapUser({
              avatarUrl: friend.avatar ?? null,
              id: String(friend.userId),
              name: friend.displayName ?? null,
              raw: friend,
            }),
          );
          return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
        },
        self: async ({ cfg, accountId }) => {
          const { getZaloUserInfo } = await loadZalouserChannelRuntime();
          const account = resolveZalouserAccountSync({ cfg, accountId });
          const parsed = await getZaloUserInfo(account.profile);
          if (!parsed?.userId) {
            return null;
          }
          return mapUser({
            avatarUrl: parsed.avatar ?? null,
            id: String(parsed.userId),
            name: parsed.displayName ?? null,
            raw: parsed,
          });
        },
      },
      gateway: {
        loginWithQrStart: async (params) => {
          const { startZaloQrLogin } = await loadZalouserChannelRuntime();
          const profile = resolveZalouserQrProfile(params.accountId);
          return await startZaloQrLogin({
            force: params.force,
            profile,
            timeoutMs: params.timeoutMs,
          });
        },
        loginWithQrWait: async (params) => {
          const { waitForZaloQrLogin } = await loadZalouserChannelRuntime();
          const profile = resolveZalouserQrProfile(params.accountId);
          return await waitForZaloQrLogin({
            profile,
            timeoutMs: params.timeoutMs,
          });
        },
        logoutAccount: async (ctx) =>
          await (
            await loadZalouserChannelRuntime()
          ).logoutZaloProfile(ctx.account.profile || resolveZalouserQrProfile(ctx.accountId)),
        startAccount: async (ctx) => {
          const { getZaloUserInfo } = await loadZalouserChannelRuntime();
          const { account } = ctx;
          let userLabel = "";
          try {
            const userInfo = await getZaloUserInfo(account.profile);
            if (userInfo?.displayName) {
              userLabel = ` (${userInfo.displayName})`;
            }
            ctx.setStatus({
              accountId: account.accountId,
              profile: userInfo,
            });
          } catch {
            // Ignore probe errors
          }
          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });
          ctx.log?.info(`[${account.accountId}] starting zalouser provider${userLabel}`);
          const { monitorZalouserProvider } = await import("./monitor.js");
          return monitorZalouserProvider({
            abortSignal: ctx.abortSignal,
            account,
            config: ctx.cfg,
            runtime: ctx.runtime,
            statusSink,
          });
        },
      },
      groups: zalouserGroupsAdapter,
      messaging: zalouserMessagingAdapter,
      resolver: zalouserResolverAdapter,
      status: createAsyncComputedAccountStatusAdapter<ResolvedZalouserAccount, ZalouserProbeResult>(
        {
          buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
          collectStatusIssues: collectZalouserStatusIssues,
          defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
          probeAccount: async ({ account, timeoutMs }) =>
            (await loadZalouserChannelRuntime()).probeZalouser(account.profile, timeoutMs),
          resolveAccountSnapshot: async ({ account, runtime }) => {
            const configured = await checkZcaAuthenticated(account.profile);
            const configError = "not authenticated";
            return {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured,
              extra: {
                dmPolicy: account.config.dmPolicy ?? "pairing",
                lastError: configured
                  ? (runtime?.lastError ?? null)
                  : (runtime?.lastError ?? configError),
              },
            };
          },
        },
      ),
    },
    outbound: zalouserOutboundAdapter,
    pairing: {
      text: zalouserPairingTextAdapter,
    },
    security: zalouserSecurityAdapter,
    threading: zalouserThreadingAdapter,
  });

export type { ResolvedZalouserAccount };
