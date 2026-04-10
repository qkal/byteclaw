import { describe, expect, it } from "vitest";
import {
  type SignalSender,
  isSignalSenderAllowed,
} from "../../../../test/helpers/channels/dm-policy-contract.js";
import {
  DM_GROUP_ACCESS_REASON,
  resolveDmGroupAccessWithLists,
} from "../../../security/dm-policy-shared.js";

interface ChannelSmokeCase {
  name: string;
  storeAllowFrom: string[];
  isSenderAllowed: (allowFrom: string[]) => boolean;
}

const signalSender: SignalSender = {
  e164: "+15550001111",
  kind: "phone",
  raw: "+15550001111",
};

const channelSmokeCases: ChannelSmokeCase[] = [
  {
    isSenderAllowed: (allowFrom) => allowFrom.includes("attacker-user"),
    name: "bluebubbles",
    storeAllowFrom: ["attacker-user"],
  },
  {
    isSenderAllowed: (allowFrom) => isSignalSenderAllowed(signalSender, allowFrom),
    name: "signal",
    storeAllowFrom: [signalSender.e164],
  },
  {
    isSenderAllowed: (allowFrom) => allowFrom.includes("user:attacker-user"),
    name: "mattermost",
    storeAllowFrom: ["user:attacker-user"],
  },
];

function expandChannelIngressCases(cases: readonly ChannelSmokeCase[]) {
  return cases.flatMap((testCase) =>
    (["message", "reaction"] as const).map((ingress) => ({
      ingress,
      testCase,
    })),
  );
}

describe("security/dm-policy-shared channel smoke", () => {
  function expectBlockedGroupAccess(params: {
    storeAllowFrom: string[];
    isSenderAllowed: (allowFrom: string[]) => boolean;
  }) {
    const access = resolveDmGroupAccessWithLists({
      allowFrom: ["owner-user"],
      dmPolicy: "pairing",
      groupAllowFrom: ["group-owner"],
      groupPolicy: "allowlist",
      isGroup: true,
      isSenderAllowed: params.isSenderAllowed,
      storeAllowFrom: params.storeAllowFrom,
    });
    expect(access.decision).toBe("block");
    expect(access.reasonCode).toBe(DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED);
    expect(access.reason).toBe("groupPolicy=allowlist (not allowlisted)");
  }

  it.each(expandChannelIngressCases(channelSmokeCases))(
    "[$testCase.name] blocks group $ingress when sender is only in pairing store",
    ({ testCase }) => {
      expectBlockedGroupAccess({
        isSenderAllowed: testCase.isSenderAllowed,
        storeAllowFrom: testCase.storeAllowFrom,
      });
    },
  );
});
