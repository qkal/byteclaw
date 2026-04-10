import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

const resolveMatrixTargetsMock = vi.hoisted(() =>
  vi.fn(async () => [{ id: "@alice:example.org", input: "Alice", resolved: true }]),
);

vi.mock("./resolve-targets.js", () => ({
  resolveMatrixTargets: resolveMatrixTargetsMock,
}));

let runMatrixAddAccountAllowlistConfigure: typeof import("./onboarding.test-harness.js").runMatrixAddAccountAllowlistConfigure;

describe("matrix onboarding account-scoped resolution", () => {
  beforeAll(async () => {
    ({ runMatrixAddAccountAllowlistConfigure } = await import("./onboarding.test-harness.js"));
  });

  beforeEach(() => {
    installMatrixTestRuntime();
    resolveMatrixTargetsMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes accountId into Matrix allowlist target resolution during onboarding", async () => {
    const result = await runMatrixAddAccountAllowlistConfigure({
      allowFromInput: "Alice",
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                accessToken: "main-token",
                homeserver: "https://matrix.main.example.org",
              },
            },
          },
        },
      } as CoreConfig,
      roomsAllowlistInput: "",
    });

    expect(result).not.toBe("skip");
    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: expect.any(Object),
      inputs: ["Alice"],
      kind: "user",
    });
  });
});
