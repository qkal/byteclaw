import { describe, expect, it } from "vitest";
import {
  LINUX_CA_BUNDLE_PATHS,
  isNodeVersionManagerRuntime,
  resolveAutoNodeExtraCaCerts,
  resolveLinuxSystemCaBundle,
} from "./node-extra-ca-certs.js";

function allowOnly(path: string) {
  return (candidate: string) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}

describe("resolveLinuxSystemCaBundle", () => {
  it("returns undefined on non-linux platforms", () => {
    expect(
      resolveLinuxSystemCaBundle({
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
        platform: "darwin",
      }),
    ).toBeUndefined();
  });

  it("returns the first readable Linux CA bundle", () => {
    expect(
      resolveLinuxSystemCaBundle({
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[1]),
        platform: "linux",
      }),
    ).toBe(LINUX_CA_BUNDLE_PATHS[1]);
  });
});

describe("isNodeVersionManagerRuntime", () => {
  it("detects nvm via NVM_DIR", () => {
    expect(isNodeVersionManagerRuntime({ NVM_DIR: "/home/test/.nvm" }, "/usr/bin/node")).toBe(true);
  });

  it("detects nvm via execPath", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/test/.nvm/versions/node/v22/bin/node")).toBe(
      true,
    );
  });

  it("returns false for non-nvm node paths", () => {
    expect(isNodeVersionManagerRuntime({}, "/usr/bin/node")).toBe(false);
  });
});

describe("resolveAutoNodeExtraCaCerts", () => {
  it("returns undefined when NODE_EXTRA_CA_CERTS is already set", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
        env: {
          NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
          NVM_DIR: "/home/test/.nvm",
        },
        platform: "linux",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when node is not nvm-managed", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
        env: {},
        execPath: "/usr/bin/node",
        platform: "linux",
      }),
    ).toBeUndefined();
  });

  it("returns the readable Linux CA bundle for nvm-managed node", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[2]),
        env: { NVM_DIR: "/home/test/.nvm" },
        execPath: "/usr/bin/node",
        platform: "linux",
      }),
    ).toBe(LINUX_CA_BUNDLE_PATHS[2]);
  });
});
