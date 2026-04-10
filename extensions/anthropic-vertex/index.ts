import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildNativeAnthropicReplayPolicyForModel } from "openclaw/plugin-sdk/provider-model-shared";
import {
  mergeImplicitAnthropicVertexProvider,
  resolveAnthropicVertexConfigApiKey,
  resolveImplicitAnthropicVertexProvider,
} from "./api.js";

const PROVIDER_ID = "anthropic-vertex";

export default definePluginEntry({
  description: "Bundled Anthropic Vertex provider plugin",
  id: PROVIDER_ID,
  name: "Anthropic Vertex Provider",
  register(api) {
    api.registerProvider({
      auth: [],
      buildReplayPolicy: ({ modelId }) => buildNativeAnthropicReplayPolicyForModel(modelId),
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const implicit = resolveImplicitAnthropicVertexProvider({
            env: ctx.env,
          });
          if (!implicit) {
            return null;
          }
          return {
            provider: mergeImplicitAnthropicVertexProvider({
              existing: ctx.config.models?.providers?.[PROVIDER_ID],
              implicit,
            }),
          };
        },
      },
      docsPath: "/providers/models",
      id: PROVIDER_ID,
      label: "Anthropic Vertex",
      resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
    });
  },
});
