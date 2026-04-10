import { type OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { parseAndResolveDiscordTarget } from "./target-resolver.js";

type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export async function parseAndResolveRecipient(
  raw: string,
  accountId?: string,
  cfg?: OpenClawConfig,
): Promise<DiscordRecipient> {
  const resolvedCfg = cfg ?? loadConfig();
  const accountInfo = resolveDiscordAccount({ accountId, cfg: resolvedCfg });
  const trimmed = raw.trim();
  const parseOptions = {
    ambiguousMessage: `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
  };
  const resolved = await parseAndResolveDiscordTarget(
    raw,
    {
      accountId: accountInfo.accountId,
      cfg: resolvedCfg,
    },
    parseOptions,
  );
  return { id: resolved.id, kind: resolved.kind };
}
