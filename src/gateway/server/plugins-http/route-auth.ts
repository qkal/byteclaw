import type { PluginRegistry } from "../../../plugins/registry.js";
import {
  type PluginRoutePathContext,
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
} from "./path-context.js";
import { findMatchingPluginHttpRoutes } from "./route-match.js";

export function matchedPluginRoutesRequireGatewayAuth(
  routes: readonly Pick<NonNullable<PluginRegistry["httpRoutes"]>[number], "auth">[],
): boolean {
  return routes.some((route) => route.auth === "gateway");
}

export function shouldEnforceGatewayAuthForPluginPath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const pathContext =
    typeof pathnameOrContext === "string"
      ? resolvePluginRoutePathContext(pathnameOrContext)
      : pathnameOrContext;
  if (pathContext.malformedEncoding || pathContext.decodePassLimitReached) {
    return true;
  }
  if (isProtectedPluginRoutePathFromContext(pathContext)) {
    return true;
  }
  return matchedPluginRoutesRequireGatewayAuth(findMatchingPluginHttpRoutes(registry, pathContext));
}
