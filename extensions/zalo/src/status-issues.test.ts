import { describe, it } from "vitest";
import { expectOpenDmPolicyConfigIssue } from "../../../test/helpers/plugins/status-issues.js";
import { collectZaloStatusIssues } from "./status-issues.js";

describe("collectZaloStatusIssues", () => {
  it("warns when dmPolicy is open", () => {
    expectOpenDmPolicyConfigIssue({
      account: {
        accountId: "default",
        configured: true,
        dmPolicy: "open",
        enabled: true,
      },
      collectIssues: collectZaloStatusIssues,
    });
  });
});
