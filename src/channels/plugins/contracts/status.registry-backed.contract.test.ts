import { describe } from "vitest";
import { installChannelStatusContractSuite } from "../../../../test/helpers/channels/registry-contract-suites.js";
import { getStatusContractRegistry } from "../../../../test/helpers/channels/registry-setup-status.js";

for (const entry of getStatusContractRegistry()) {
  describe(`${entry.id} status contract`, () => {
    installChannelStatusContractSuite({
      cases: entry.cases as never,
      plugin: entry.plugin,
    });
  });
}
