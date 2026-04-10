import { describe, expect, it } from "vitest";
import { buildOpenClawChromeLaunchArgs } from "./chrome.js";

describe("browser chrome launch args", () => {
  it("does not force an about:blank tab at startup", () => {
    const args = buildOpenClawChromeLaunchArgs({
      profile: {
        attachOnly: false,
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 18_800,
        cdpUrl: "http://127.0.0.1:18800",
        color: "#FF4500",
        driver: "openclaw",
        name: "openclaw",
      },
      resolved: {
        attachOnly: false,
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPortRangeEnd: 18_810,
        cdpPortRangeStart: 18_800,
        cdpProtocol: "http",
        color: "#FF4500",
        controlPort: 18_791,
        defaultProfile: "openclaw",
        enabled: true,
        evaluateEnabled: false,
        extraArgs: [],
        headless: false,
        noSandbox: false,
        profiles: {
          openclaw: { cdpPort: 18_800, color: "#FF4500" },
        },
        remoteCdpHandshakeTimeoutMs: 3000,
        remoteCdpTimeoutMs: 1500,
        ssrfPolicy: { allowPrivateNetwork: true },
      },
      userDataDir: "/tmp/openclaw-test-user-data",
    });

    expect(args).not.toContain("about:blank");
    expect(args).toContain("--remote-debugging-port=18800");
    expect(args).toContain("--user-data-dir=/tmp/openclaw-test-user-data");
  });
});
