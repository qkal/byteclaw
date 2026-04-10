import type { ChannelMeta } from "./types.js";

export function resolveChannelExposure(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
) {
  return {
    configured: meta.exposure?.configured ?? meta.showConfigured ?? true,
    docs: meta.exposure?.docs ?? true,
    setup: meta.exposure?.setup ?? meta.showInSetup ?? true,
  };
}

export function isChannelVisibleInConfiguredLists(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
): boolean {
  return resolveChannelExposure(meta).configured;
}

export function isChannelVisibleInSetup(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
): boolean {
  return resolveChannelExposure(meta).setup;
}

export function isChannelVisibleInDocs(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
): boolean {
  return resolveChannelExposure(meta).docs;
}
