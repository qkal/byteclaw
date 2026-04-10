import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  mergeImplicitMantleProvider,
  resolveImplicitMantleProvider,
  resolveMantleBearerToken,
} from "./discovery.js";

export function registerBedrockMantlePlugin(api: OpenClawPluginApi): void {
  const providerId = "amazon-bedrock-mantle";

  api.registerProvider({
    auth: [],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const implicit = await resolveImplicitMantleProvider({
          env: ctx.env,
        });
        if (!implicit) {
          return null;
        }
        return {
          provider: mergeImplicitMantleProvider({
            existing: ctx.config.models?.providers?.[providerId],
            implicit,
          }),
        };
      },
    },
    classifyFailoverReason: ({ errorMessage }) => {
      if (/rate_limit|too many requests|429/i.test(errorMessage)) {
        return "rate_limit";
      }
      if (/overloaded|503/i.test(errorMessage)) {
        return "overloaded";
      }
      return undefined;
    },
    docsPath: "/providers/bedrock-mantle",
    id: providerId,
    label: "Amazon Bedrock Mantle (OpenAI-compatible)",
    matchesContextOverflowError: ({ errorMessage }) =>
      /context_length_exceeded|max.*tokens.*exceeded/i.test(errorMessage),
    resolveConfigApiKey: ({ env }) =>
      resolveMantleBearerToken(env) ? "AWS_BEARER_TOKEN_BEDROCK" : undefined,
  });
}
