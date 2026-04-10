import { createLegacyPrivateNetworkDoctorContract } from "openclaw/plugin-sdk/ssrf-runtime";

const contract = createLegacyPrivateNetworkDoctorContract({
  channelKey: "mattermost",
});

export const { legacyConfigRules } = contract;

export const { normalizeCompatibilityConfig } = contract;
