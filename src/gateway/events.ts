import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

export interface GatewayUpdateAvailableEventPayload {
  updateAvailable: UpdateAvailable | null;
}
