import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuTarget } from "./targets.js";

function normalizeFeishuApproverId(value: string | number): string | undefined {
  const normalized = normalizeFeishuTarget(String(value));
  const trimmed = normalizeOptionalLowercaseString(normalized);
  return trimmed?.startsWith("ou_") ? trimmed : undefined;
}

export const feishuApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Feishu",
  normalizeSenderId: (value) => normalizeFeishuApproverId(value),
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveFeishuAccount({ accountId, cfg }).config;
    return resolveApprovalApprovers({
      allowFrom: account.allowFrom,
      normalizeApprover: normalizeFeishuApproverId,
    });
  },
});
