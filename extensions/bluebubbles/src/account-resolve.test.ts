import { describe, expect, it } from "vitest";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";

describe("resolveBlueBubblesServerAccount", () => {
  it("respects an explicit private-network opt-out for loopback server URLs", () => {
    expect(
      resolveBlueBubblesServerAccount({
        cfg: {
          channels: {
            bluebubbles: {
              network: {
                dangerouslyAllowPrivateNetwork: false,
              },
            },
          },
        },
        password: "test-password",
        serverUrl: "http://127.0.0.1:1234",
      }),
    ).toMatchObject({
      allowPrivateNetwork: false,
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
    });
  });

  it("lets a legacy per-account opt-in override a channel-level canonical default", () => {
    expect(
      resolveBlueBubblesServerAccount({
        accountId: "personal",
        cfg: {
          channels: {
            bluebubbles: {
              accounts: {
                personal: {
                  allowPrivateNetwork: true,
                  password: "test-password",
                  serverUrl: "http://127.0.0.1:1234",
                },
              },
              network: {
                dangerouslyAllowPrivateNetwork: false,
              },
            },
          },
        },
      }),
    ).toMatchObject({
      accountId: "personal",
      allowPrivateNetwork: true,
      allowPrivateNetworkConfig: true,
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
    });
  });

  it("uses accounts.default config for the default BlueBubbles account", () => {
    expect(
      resolveBlueBubblesServerAccount({
        cfg: {
          channels: {
            bluebubbles: {
              accounts: {
                default: {
                  allowPrivateNetwork: true,
                  password: "test-password",
                  serverUrl: "http://127.0.0.1:1234",
                },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      accountId: "default",
      allowPrivateNetwork: true,
      allowPrivateNetworkConfig: true,
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
    });
  });
});
