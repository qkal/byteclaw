import { z } from "zod";
import type { PluginLogger } from "../api.js";
import {
  type OpenClawConfig,
  normalizeWebhookPath,
  resolveConfiguredSecretInputString,
} from "../runtime-api.js";

const secretRefSchema = z
  .object({
    id: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    source: z.enum(["env", "file", "exec"]),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

const webhookRouteConfigSchema = z
  .object({
    controllerId: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional().default(true),
    path: z.string().trim().min(1).optional(),
    secret: secretInputSchema,
    sessionKey: z.string().trim().min(1),
  })
  .strict();

const webhooksPluginConfigSchema = z
  .object({
    routes: z.record(z.string().trim().min(1), webhookRouteConfigSchema).default({}),
  })
  .strict();

export interface ResolvedWebhookRouteConfig {
  routeId: string;
  path: string;
  sessionKey: string;
  secret: string;
  controllerId: string;
  description?: string;
}

export async function resolveWebhooksPluginConfig(params: {
  pluginConfig: unknown;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  logger?: PluginLogger;
}): Promise<ResolvedWebhookRouteConfig[]> {
  const parsed = webhooksPluginConfigSchema.parse(params.pluginConfig ?? {});
  const resolvedRoutes: ResolvedWebhookRouteConfig[] = [];
  const seenPaths = new Map<string, string>();

  for (const [routeId, route] of Object.entries(parsed.routes)) {
    if (!route.enabled) {
      continue;
    }
    const path = normalizeWebhookPath(route.path ?? `/plugins/webhooks/${routeId}`);
    const existingRouteId = seenPaths.get(path);
    if (existingRouteId) {
      throw new Error(
        `webhooks.routes.${routeId}.path conflicts with routes.${existingRouteId}.path (${path}).`,
      );
    }

    const secretResolution = await resolveConfiguredSecretInputString({
      config: params.cfg,
      env: params.env,
      path: `plugins.entries.webhooks.routes.${routeId}.secret`,
      value: route.secret,
    });
    const secret = secretResolution.value?.trim();
    if (!secret) {
      params.logger?.warn?.(
        `[webhooks] skipping route ${routeId}: ${
          secretResolution.unresolvedRefReason ?? "secret is empty or unresolved"
        }`,
      );
      continue;
    }

    seenPaths.set(path, routeId);
    resolvedRoutes.push({
      controllerId: route.controllerId ?? `webhooks/${routeId}`,
      path,
      routeId,
      secret,
      sessionKey: route.sessionKey,
      ...(route.description ? { description: route.description } : {}),
    });
  }

  return resolvedRoutes;
}
