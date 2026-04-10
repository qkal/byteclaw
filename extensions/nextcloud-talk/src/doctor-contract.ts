import { createLegacyPrivateNetworkDoctorContract } from "openclaw/plugin-sdk/ssrf-runtime";

const contract = createLegacyPrivateNetworkDoctorContract({
  channelKey: "nextcloud-talk",
});

export const { legacyConfigRules } = contract;

export const { normalizeCompatibilityConfig } = contract;
