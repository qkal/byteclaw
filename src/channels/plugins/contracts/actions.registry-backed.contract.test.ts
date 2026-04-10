import { describe } from "vitest";
import { getActionContractRegistry } from "../../../../test/helpers/channels/registry-actions.js";
import { installChannelActionsContractSuite } from "../../../../test/helpers/channels/registry-contract-suites.js";

for (const entry of getActionContractRegistry()) {
  describe(`${entry.id} actions contract`, () => {
    installChannelActionsContractSuite({
      cases: entry.cases as never,
      plugin: entry.plugin,
      unsupportedAction: entry.unsupportedAction as never,
    });
  });
}
