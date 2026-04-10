import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveZaloAccount } from "./accounts.js";

function normalizeZaloApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(zalo|zl):/i, "")
    .trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

export const zaloApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Zalo",
  normalizeSenderId: (value) => normalizeZaloApproverId(value),
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveZaloAccount({ accountId, cfg }).config;
    return resolveApprovalApprovers({
      allowFrom: account.allowFrom,
      normalizeApprover: normalizeZaloApproverId,
    });
  },
});
