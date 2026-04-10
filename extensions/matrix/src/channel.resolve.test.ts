import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";

const resolveMatrixTargetsMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./resolve-targets.js", () => ({
  resolveMatrixTargets: resolveMatrixTargetsMock,
}));

import { matrixResolverAdapter } from "./resolver.js";

describe("matrix resolver adapter", () => {
  beforeEach(() => {
    resolveMatrixTargetsMock.mockClear();
  });

  it("forwards accountId into Matrix target resolution", async () => {
    await matrixResolverAdapter.resolveTargets({
      accountId: "ops",
      cfg: { channels: { matrix: {} } },
      inputs: ["Alice"],
      kind: "user",
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: { channels: { matrix: {} } },
      inputs: ["Alice"],
      kind: "user",
      runtime: expect.objectContaining({
        error: expect.any(Function),
        exit: expect.any(Function),
        log: expect.any(Function),
      }),
    });
  });
});
