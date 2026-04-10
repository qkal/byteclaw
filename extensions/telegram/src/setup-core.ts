import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup-runtime";
import {
  type OpenClawConfig,
  type WizardPrompter,
  createEnvPatchedAccountSetupAdapter,
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDefaultTelegramAccountId, resolveTelegramAccount } from "./accounts.js";
import { lookupTelegramChatId } from "./api-fetch.js";

const channel = "telegram" as const;

export const TELEGRAM_TOKEN_HELP_LINES = [
  "1) Open Telegram and chat with @BotFather",
  "2) Run /newbot (or /mybots)",
  "3) Copy the token (looks like 123456:ABC...)",
  "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
  `Docs: ${formatDocsLink("/telegram")}`,
  "Website: https://openclaw.ai",
];

export const TELEGRAM_USER_ID_HELP_LINES = [
  `1) DM your bot, then read from.id in \`${formatCliCommand("openclaw logs --follow")}\` (safest)`,
  "2) Or call https://api.telegram.org/bot<bot_token>/getUpdates and read message.from.id",
  "3) Third-party: DM @userinfobot or @getidsbot",
  `Docs: ${formatDocsLink("/telegram")}`,
  "Website: https://openclaw.ai",
];

export function normalizeTelegramAllowFromInput(raw: string): string {
  return raw
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function parseTelegramAllowFromId(raw: string): string | null {
  const stripped = normalizeTelegramAllowFromInput(raw);
  return /^\d+$/.test(stripped) ? stripped : null;
}

export async function resolveTelegramAllowFromEntries(params: {
  entries: string[];
  credentialValue?: string;
  apiRoot?: string;
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
}) {
  return await Promise.all(
    params.entries.map(async (entry) => {
      const numericId = parseTelegramAllowFromId(entry);
      if (numericId) {
        return { id: numericId, input: entry, resolved: true };
      }
      const stripped = normalizeTelegramAllowFromInput(entry);
      if (!stripped || !params.credentialValue?.trim()) {
        return { id: null, input: entry, resolved: false };
      }
      const username = stripped.startsWith("@") ? stripped : `@${stripped}`;
      const id = await lookupTelegramChatId({
        apiRoot: params.apiRoot,
        chatId: username,
        network: params.network,
        proxyUrl: params.proxyUrl,
        token: params.credentialValue,
      });
      return { id, input: entry, resolved: Boolean(id) };
    }),
  );
}

export async function promptTelegramAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}) {
  const accountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
  const resolved = resolveTelegramAccount({ accountId, cfg: params.cfg });
  await params.prompter.note(TELEGRAM_USER_ID_HELP_LINES.join("\n"), "Telegram user id");
  if (!resolved.token?.trim()) {
    await params.prompter.note(
      "Telegram token missing; username lookup is unavailable.",
      "Telegram",
    );
  }
  const unique = await promptResolvedAllowFrom({
    existing: resolved.config.allowFrom ?? [],
    invalidWithoutTokenNote:
      "Telegram token missing; use numeric sender ids (usernames require a bot token).",
    label: "Telegram allowlist",
    message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
    parseId: parseTelegramAllowFromId,
    parseInputs: splitSetupEntries,
    placeholder: "@username",
    prompter: params.prompter,
    resolveEntries: async ({ entries, token }) =>
      resolveTelegramAllowFromEntries({
        apiRoot: resolved.config.apiRoot,
        credentialValue: token,
        entries,
        network: resolved.config.network,
        proxyUrl: resolved.config.proxy,
      }),
    token: resolved.token,
  });
  return patchChannelConfigForAccount({
    accountId,
    cfg: params.cfg,
    channel,
    patch: { allowFrom: unique, dmPolicy: "allowlist" },
  });
}

export const telegramSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  buildPatch: (input) =>
    input.tokenFile ? { tokenFile: input.tokenFile } : (input.token ? { botToken: input.token } : {}),
  channelKey: channel,
  defaultAccountOnlyEnvError: "TELEGRAM_BOT_TOKEN can only be used for the default account.",
  hasCredentials: (input) => Boolean(input.token || input.tokenFile),
  missingCredentialError: "Telegram requires token or --token-file (or --use-env).",
});
