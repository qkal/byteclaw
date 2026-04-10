import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { listEnabledZaloAccounts, resolveZaloAccount } from "./accounts.js";

const loadZaloActionsRuntime = createLazyRuntimeNamedExport(
  () => import("./actions.runtime.js"),
  "zaloActionsRuntime",
);

const providerId = "zalo";

function listEnabledAccounts(cfg: OpenClawConfig, accountId?: string | null) {
  return (
    accountId ? [resolveZaloAccount({ accountId, cfg })] : listEnabledZaloAccounts(cfg)
  ).filter((account) => account.enabled && account.tokenSource !== "none");
}

export const zaloMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = listEnabledAccounts(cfg, accountId);
    if (accounts.length === 0) {
      return null;
    }
    const actions = new Set<ChannelMessageActionName>(["send"]);
    return { actions: [...actions], capabilities: [] };
  },
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        allowEmpty: true,
        required: true,
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });

      const { sendMessageZalo } = await loadZaloActionsRuntime();
      const result = await sendMessageZalo(to ?? "", content ?? "", {
        accountId: accountId ?? undefined,
        cfg,
        mediaUrl: mediaUrl ?? undefined,
      });

      if (!result.ok) {
        return jsonResult({
          error: result.error ?? "Failed to send Zalo message",
          ok: false,
        });
      }

      return jsonResult({ messageId: result.messageId, ok: true, to });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
