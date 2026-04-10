import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { type OpenClawConfig, resolveExactLineGroupConfigKey } from "./channel-api.js";

interface LineGroupContext {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
}

export function resolveLineGroupRequireMention(params: LineGroupContext): boolean {
  const exactGroupId = resolveExactLineGroupConfigKey({
    accountId: params.accountId,
    cfg: params.cfg,
    groupId: params.groupId,
  });
  return resolveChannelGroupRequireMention({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "line",
    groupId: exactGroupId ?? params.groupId,
  });
}
