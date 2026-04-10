import { clearCredentialsCache, extractGeminiCliCredentials } from "./oauth.credentials.js";
import {
  buildAuthUrl,
  generateOAuthState,
  generatePkce,
  parseCallbackInput,
  shouldUseManualOAuthFlow,
  waitForLocalCallback,
} from "./oauth.flow.js";
import type { GeminiCliOAuthContext, GeminiCliOAuthCredentials } from "./oauth.shared.js";
import { exchangeCodeForTokens } from "./oauth.token.js";

export { clearCredentialsCache, extractGeminiCliCredentials };
export type { GeminiCliOAuthContext, GeminiCliOAuthCredentials };

export async function loginGeminiCliOAuth(
  ctx: GeminiCliOAuthContext,
): Promise<GeminiCliOAuthCredentials> {
  const needsManual = shouldUseManualOAuthFlow(ctx.isRemote);
  await ctx.note(
    needsManual
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, copy the redirect URL and paste it back here.",
        ].join("\n")
      : [
          "Browser will open for Google authentication.",
          "Sign in with your Google account for Gemini CLI access.",
          "The callback will be captured automatically on localhost:8085.",
        ].join("\n"),
    "Gemini CLI OAuth",
  );

  const { verifier, challenge } = generatePkce();
  const state = generateOAuthState();
  const authUrl = buildAuthUrl(challenge, state);

  if (needsManual) {
    ctx.progress.update("OAuth URL ready");
    ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
    ctx.progress.update("Waiting for you to paste the callback URL...");
    const callbackInput = await ctx.prompt("Paste the redirect URL here: ");
    const parsed = parseCallbackInput(callbackInput);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    if (parsed.state !== state) {
      throw new Error("OAuth state mismatch - please try again");
    }
    ctx.progress.update("Exchanging authorization code for tokens...");
    return exchangeCodeForTokens(parsed.code, verifier);
  }

  ctx.progress.update("Complete sign-in in browser...");
  try {
    await ctx.openUrl(authUrl);
  } catch {
    ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
  }

  try {
    const { code } = await waitForLocalCallback({
      expectedState: state,
      onProgress: (msg) => ctx.progress.update(msg),
      timeoutMs: 5 * 60 * 1000,
    });
    ctx.progress.update("Exchanging authorization code for tokens...");
    return await exchangeCodeForTokens(code, verifier);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("EADDRINUSE") ||
        error.message.includes("port") ||
        error.message.includes("listen"))
    ) {
      ctx.progress.update("Local callback server failed. Switching to manual mode...");
      ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
      const callbackInput = await ctx.prompt("Paste the redirect URL here: ");
      const parsed = parseCallbackInput(callbackInput);
      if ("error" in parsed) {
        throw new Error(parsed.error, { cause: error });
      }
      if (parsed.state !== state) {
        throw new Error("OAuth state mismatch - please try again", { cause: error });
      }
      ctx.progress.update("Exchanging authorization code for tokens...");
      return exchangeCodeForTokens(parsed.code, verifier);
    }
    throw error;
  }
}
