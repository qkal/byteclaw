import { createPatchedAccountSetupAdapter } from "openclaw/plugin-sdk/setup-runtime";

const channel = "zalouser" as const;

export const zalouserSetupAdapter = createPatchedAccountSetupAdapter({
  buildPatch: () => ({}),
  channelKey: channel,
  validateInput: () => null,
});
