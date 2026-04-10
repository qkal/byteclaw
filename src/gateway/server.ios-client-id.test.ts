import { describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import { validateConnectParams } from "./protocol/index.js";

function makeConnectParams(clientId: string) {
  return {
    caps: ["canvas"],
    client: {
      id: clientId,
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "ios",
      version: "dev",
    },
    commands: ["system.notify"],
    maxProtocol: 1,
    minProtocol: 1,
    permissions: {},
    role: "node",
    scopes: [],
  };
}

describe("connect params client id validation", () => {
  test.each([GATEWAY_CLIENT_IDS.IOS_APP, GATEWAY_CLIENT_IDS.ANDROID_APP])(
    "accepts %s as a valid gateway client id",
    (clientId) => {
      const ok = validateConnectParams(makeConnectParams(clientId));
      expect(ok).toBe(true);
      expect(validateConnectParams.errors ?? []).toHaveLength(0);
    },
  );

  test("rejects unknown client ids", () => {
    const ok = validateConnectParams(makeConnectParams("openclaw-mobile"));
    expect(ok).toBe(false);
  });
});
