import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderFetchUsageSnapshotContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth-result";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { fetchGeminiUsage } from "openclaw/plugin-sdk/provider-usage";
import { formatGoogleOauthApiKey, parseGoogleUsageToken } from "./oauth-token-shared.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = "google-gemini-cli";
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google-gemini-cli/gemini-3.1-pro-preview";
const ENV_VARS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
] as const;

const GOOGLE_GEMINI_CLI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
  ...buildProviderStreamFamilyHooks("google-thinking"),
  ...buildProviderToolCompatFamilyHooks("gemini"),
};

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

export function registerGoogleGeminiCliProvider(api: OpenClawPluginApi) {
  api.registerProvider({
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [...ENV_VARS],
    auth: [
      {
        hint: "PKCE + localhost callback",
        id: "oauth",
        kind: "oauth",
        label: "Google OAuth",
        run: async (ctx: ProviderAuthContext) => {
          await ctx.prompter.note(
            [
              "This is an unofficial integration and is not endorsed by Google.",
              "Some users have reported account restrictions or suspensions after using third-party Gemini CLI and Antigravity OAuth clients.",
              "Proceed only if you understand and accept this risk.",
            ].join("\n"),
            "Google Gemini CLI caution",
          );

          const proceed = await ctx.prompter.confirm({
            initialValue: false,
            message: "Continue with Google Gemini CLI OAuth?",
          });
          if (!proceed) {
            await ctx.prompter.note("Skipped Google Gemini CLI OAuth setup.", "Setup skipped");
            return { profiles: [] };
          }

          const spin = ctx.prompter.progress("Starting Gemini CLI OAuth…");
          try {
            const { loginGeminiCliOAuth } = await import("./oauth.runtime.js");
            const result = await loginGeminiCliOAuth({
              isRemote: ctx.isRemote,
              log: (msg) => ctx.runtime.log(msg),
              note: ctx.prompter.note,
              openUrl: ctx.openUrl,
              progress: spin,
              prompt: async (message) => String(await ctx.prompter.text({ message })),
            });

            spin.stop("Gemini CLI OAuth complete");
            return buildOauthProviderAuthResult({
              access: result.access,
              defaultModel: DEFAULT_MODEL,
              email: result.email,
              expires: result.expires,
              providerId: PROVIDER_ID,
              refresh: result.refresh,
              ...(result.projectId ? { credentialExtra: { projectId: result.projectId } } : {}),
              ...(result.projectId
                ? {
                    notes: [
                      "If requests fail, set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.",
                    ],
                  }
                : {}),
            });
          } catch (error) {
            spin.stop("Gemini CLI OAuth failed");
            await ctx.prompter.note(
              "Trouble with OAuth? Ensure your Google account has Gemini CLI access.",
              "OAuth help",
            );
            throw error;
          }
        },
      },
    ],
    wizard: {
      setup: {
        choiceHint: "Google OAuth with project-aware token payload",
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        methodId: "oauth",
      },
    },
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        ctx,
        providerId: PROVIDER_ID,
      }),
    ...GOOGLE_GEMINI_CLI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
    resolveUsageAuth: async (ctx) => {
      const auth = await ctx.resolveOAuthToken();
      if (!auth) {
        return null;
      }
      return {
        ...auth,
        token: parseGoogleUsageToken(auth.token),
      };
    },
    fetchUsageSnapshot: async (ctx) => await fetchGeminiCliUsage(ctx),
  });
}
