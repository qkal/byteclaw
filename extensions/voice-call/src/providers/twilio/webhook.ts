import type { WebhookContext, WebhookVerificationResult } from "../../types.js";
import { verifyTwilioWebhook } from "../../webhook-security.js";
import type { TwilioProviderOptions } from "../twilio.types.js";

export function verifyTwilioProviderWebhook(params: {
  ctx: WebhookContext;
  authToken: string;
  currentPublicUrl?: string | null;
  options: TwilioProviderOptions;
}): WebhookVerificationResult {
  const result = verifyTwilioWebhook(params.ctx, params.authToken, {
    allowNgrokFreeTierLoopbackBypass: params.options.allowNgrokFreeTierLoopbackBypass ?? false,
    allowedHosts: params.options.webhookSecurity?.allowedHosts,
    publicUrl: params.currentPublicUrl || undefined,
    remoteIP: params.ctx.remoteAddress,
    skipVerification: params.options.skipVerification,
    trustForwardingHeaders: params.options.webhookSecurity?.trustForwardingHeaders,
    trustedProxyIPs: params.options.webhookSecurity?.trustedProxyIPs,
  });

  if (!result.ok) {
    console.warn(`[twilio] Webhook verification failed: ${result.reason}`);
    if (result.verificationUrl) {
      console.warn(`[twilio] Verification URL: ${result.verificationUrl}`);
    }
  }

  return {
    isReplay: result.isReplay,
    ok: result.ok,
    reason: result.reason,
    verifiedRequestKey: result.verifiedRequestKey,
  };
}
