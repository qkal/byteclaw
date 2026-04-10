import {
  applyTlonSetupConfig,
  createTlonSetupWizardBase,
  resolveTlonSetupConfigured,
  resolveTlonSetupStatusLines,
} from "./setup-core.js";
import { normalizeShip } from "./targets.js";
import { type TlonResolvedAccount, resolveTlonAccount } from "./types.js";
import { isBlockedUrbitHostname, validateUrbitBaseUrl } from "./urbit/base-url.js";

const _channel = "tlon" as const;

function _isConfigured(account: TlonResolvedAccount): boolean {
  return Boolean(account.ship && account.url && account.code);
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export { tlonSetupAdapter } from "./setup-core.js";

export const tlonSetupWizard = createTlonSetupWizardBase({
  finalize: async ({ cfg, accountId, prompter }) => {
    let next = cfg;
    const resolved = resolveTlonAccount(next, accountId);
    const validatedUrl = validateUrbitBaseUrl(resolved.url ?? "");
    if (!validatedUrl.ok) {
      throw new Error(`Invalid URL: ${validatedUrl.error}`);
    }

    let dangerouslyAllowPrivateNetwork = resolved.dangerouslyAllowPrivateNetwork ?? false;
    if (isBlockedUrbitHostname(validatedUrl.hostname)) {
      dangerouslyAllowPrivateNetwork = await prompter.confirm({
        initialValue: dangerouslyAllowPrivateNetwork,
        message:
          "Ship URL looks like a private/internal host. Allow private network access? (SSRF risk)",
      });
      if (!dangerouslyAllowPrivateNetwork) {
        throw new Error("Refusing private/internal ship URL without explicit network opt-in");
      }
    }
    next = applyTlonSetupConfig({
      accountId,
      cfg: next,
      input: { dangerouslyAllowPrivateNetwork },
    });

    const currentGroups = resolved.groupChannels;
    const wantsGroupChannels = await prompter.confirm({
      initialValue: currentGroups.length > 0,
      message: "Add group channels manually? (optional)",
    });
    if (wantsGroupChannels) {
      const entry = await prompter.text({
        initialValue: currentGroups.join(", ") || undefined,
        message: "Group channels (comma-separated)",
        placeholder: "chat/~host-ship/general, chat/~host-ship/support",
      });
      next = applyTlonSetupConfig({
        accountId,
        cfg: next,
        input: { groupChannels: parseList(String(entry ?? "")) },
      });
    }

    const currentAllowlist = resolved.dmAllowlist;
    const wantsAllowlist = await prompter.confirm({
      initialValue: currentAllowlist.length > 0,
      message: "Restrict DMs with an allowlist?",
    });
    if (wantsAllowlist) {
      const entry = await prompter.text({
        initialValue: currentAllowlist.join(", ") || undefined,
        message: "DM allowlist (comma-separated ship names)",
        placeholder: "~zod, ~nec",
      });
      next = applyTlonSetupConfig({
        accountId,
        cfg: next,
        input: {
          dmAllowlist: parseList(String(entry ?? "")).map((ship) => normalizeShip(ship)),
        },
      });
    }

    const autoDiscoverChannels = await prompter.confirm({
      initialValue: resolved.autoDiscoverChannels ?? true,
      message: "Enable auto-discovery of group channels?",
    });
    next = applyTlonSetupConfig({
      accountId,
      cfg: next,
      input: { autoDiscoverChannels },
    });

    return { cfg: next };
  },
  resolveConfigured: async ({ cfg, accountId }) => await resolveTlonSetupConfigured(cfg, accountId),
  resolveStatusLines: async ({ cfg, accountId }) =>
    await resolveTlonSetupStatusLines(cfg, accountId),
});
