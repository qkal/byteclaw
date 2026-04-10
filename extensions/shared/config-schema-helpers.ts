import { requireOpenAllowFrom } from "openclaw/plugin-sdk/channel-config-primitives";
import type { z } from "openclaw/plugin-sdk/zod";

export function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy?: string;
  allowFrom?: (string | number)[];
  ctx: z.RefinementCtx;
}) {
  requireOpenAllowFrom({
    allowFrom: params.allowFrom,
    ctx: params.ctx,
    message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`,
    path: ["allowFrom"],
    policy: params.policy,
  });
}
