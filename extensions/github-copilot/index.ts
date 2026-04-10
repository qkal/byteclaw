import { type ProviderAuthContext, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const COPILOT_XHIGH_MODEL_IDS = ["gpt-5.2", "gpt-5.2-codex"] as const;

interface GithubCopilotPluginConfig {
  discovery?: {
    enabled?: boolean;
  };
}

async function loadGithubCopilotRuntime() {
  return await import("./register.runtime.js");
}
export default definePluginEntry({
  description: "Bundled GitHub Copilot provider plugin",
  id: "github-copilot",
  name: "GitHub Copilot Provider",
  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as GithubCopilotPluginConfig;
    function resolveFirstGithubToken(params: { agentDir?: string; env: NodeJS.ProcessEnv }): {
      githubToken: string;
      hasProfile: boolean;
    } {
      const authStore = ensureAuthProfileStore(params.agentDir, {
        allowKeychainPrompt: false,
      });
      const hasProfile = listProfilesForProvider(authStore, PROVIDER_ID).length > 0;
      const envToken =
        params.env.COPILOT_GITHUB_TOKEN ?? params.env.GH_TOKEN ?? params.env.GITHUB_TOKEN ?? "";
      const githubToken = envToken.trim();
      if (githubToken || !hasProfile) {
        return { githubToken, hasProfile };
      }

      const profileId = listProfilesForProvider(authStore, PROVIDER_ID)[0];
      const profile = profileId ? authStore.profiles[profileId] : undefined;
      if (profile?.type !== "token") {
        return { githubToken: "", hasProfile };
      }
      const directToken = profile.token?.trim() ?? "";
      if (directToken) {
        return { githubToken: directToken, hasProfile };
      }
      const tokenRef = coerceSecretRef(profile.tokenRef);
      if (tokenRef?.source === "env" && tokenRef.id.trim()) {
        return {
          githubToken: (params.env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim(),
          hasProfile,
        };
      }
      return { githubToken: "", hasProfile };
    }

    async function runGitHubCopilotAuth(ctx: ProviderAuthContext) {
      const { githubCopilotLoginCommand } = await loadGithubCopilotRuntime();
      await ctx.prompter.note(
        [
          "This will open a GitHub device login to authorize Copilot.",
          "Requires an active GitHub Copilot subscription.",
        ].join("\n"),
        "GitHub Copilot",
      );

      if (!process.stdin.isTTY) {
        await ctx.prompter.note(
          "GitHub Copilot login requires an interactive TTY.",
          "GitHub Copilot",
        );
        return { profiles: [] };
      }

      try {
        await githubCopilotLoginCommand(
          { profileId: "github-copilot:github", yes: true },
          ctx.runtime,
        );
      } catch (error) {
        await ctx.prompter.note(`GitHub Copilot login failed: ${String(error)}`, "GitHub Copilot");
        return { profiles: [] };
      }

      const authStore = ensureAuthProfileStore(undefined, {
        allowKeychainPrompt: false,
      });
      const credential = authStore.profiles["github-copilot:github"];
      if (!credential || credential.type !== "token") {
        return { profiles: [] };
      }

      return {
        defaultModel: "github-copilot/gpt-4o",
        profiles: [
          {
            profileId: "github-copilot:github",
            credential,
          },
        ],
      };
    }

    api.registerProvider({
      auth: [
        {
          id: "device",
          label: "GitHub device login",
          hint: "Browser device-code flow",
          kind: "device_code",
          run: async (ctx) => await runGitHubCopilotAuth(ctx),
        },
      ],
      buildReplayPolicy: ({ modelId }) => buildGithubCopilotReplayPolicy(modelId),
      catalog: {
        order: "late",
        run: async (ctx) => {
          const discoveryEnabled =
            pluginConfig.discovery?.enabled ?? ctx.config?.models?.copilotDiscovery?.enabled;
          if (discoveryEnabled === false) {
            return null;
          }
          const { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } =
            await loadGithubCopilotRuntime();
          const { githubToken, hasProfile } = resolveFirstGithubToken({
            agentDir: ctx.agentDir,
            env: ctx.env,
          });
          if (!hasProfile && !githubToken) {
            return null;
          }
          let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
          if (githubToken) {
            try {
              const token = await resolveCopilotApiToken({
                githubToken,
                env: ctx.env,
              });
              baseUrl = token.baseUrl;
            } catch {
              baseUrl = DEFAULT_COPILOT_API_BASE_URL;
            }
          }
          return {
            provider: {
              baseUrl,
              models: [],
            },
          };
        },
      },
      docsPath: "/providers/models",
      envVars: COPILOT_ENV_VARS,
      fetchUsageSnapshot: async (ctx) => {
        const { fetchCopilotUsage } = await loadGithubCopilotRuntime();
        return await fetchCopilotUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
      },
      id: PROVIDER_ID,
      label: "GitHub Copilot",
      prepareRuntimeAuth: async (ctx) => {
        const { resolveCopilotApiToken } = await loadGithubCopilotRuntime();
        const token = await resolveCopilotApiToken({
          githubToken: ctx.apiKey,
          env: ctx.env,
        });
        return {
          apiKey: token.token,
          baseUrl: token.baseUrl,
          expiresAt: token.expiresAt,
        };
      },
      resolveDynamicModel: (ctx) => resolveCopilotForwardCompatModel(ctx),
      resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
      supportsXHighThinking: ({ modelId }) =>
        COPILOT_XHIGH_MODEL_IDS.includes(
          (normalizeOptionalLowercaseString(modelId) ?? "") as never,
        ),
      wizard: {
        setup: {
          choiceHint: "Device login with your GitHub account",
          choiceId: "github-copilot",
          choiceLabel: "GitHub Copilot",
          methodId: "device",
        },
      },
      wrapStreamFn: wrapCopilotProviderStream,
    });
  },
});
