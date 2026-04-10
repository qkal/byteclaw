import { readStringValue } from "../shared/string-coerce.js";

export interface GatewaySelfPresence {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
}

export function pickGatewaySelfPresence(presence: unknown): GatewaySelfPresence | null {
  if (!Array.isArray(presence)) {
    return null;
  }
  const entries = presence as Record<string, unknown>[];
  const self =
    entries.find((e) => e.mode === "gateway" && e.reason === "self") ??
    // Back-compat: older presence payloads only included a `text` line.
    entries.find((e) => typeof e.text === "string" && String(e.text).startsWith("Gateway:")) ??
    null;
  if (!self) {
    return null;
  }
  return {
    host: readStringValue(self.host),
    ip: readStringValue(self.ip),
    platform: readStringValue(self.platform),
    version: readStringValue(self.version),
  };
}
