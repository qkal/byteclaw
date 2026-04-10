import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { type GatewayService, readGatewayServiceState } from "../daemon/service.js";

export interface ServiceStatusSummary {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
}

export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
): Promise<ServiceStatusSummary> {
  try {
    const state = await readGatewayServiceState(service, { env: process.env });
    const managedByOpenClaw = state.installed;
    const externallyManaged = !managedByOpenClaw && state.running;
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : (state.loaded
        ? service.loadedText
        : service.notLoadedText);
    return {
      externallyManaged,
      installed,
      label: service.label,
      loaded: state.loaded,
      loadedText,
      managedByOpenClaw,
      runtime: state.runtime,
    };
  } catch {
    return {
      externallyManaged: false,
      installed: null,
      label: fallbackLabel,
      loaded: false,
      loadedText: "unknown",
      managedByOpenClaw: false,
      runtime: undefined,
    };
  }
}
