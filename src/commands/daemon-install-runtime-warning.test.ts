import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  renderSystemNodeWarning: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
}));

import { emitNodeRuntimeWarning } from "./daemon-install-runtime-warning.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("emitNodeRuntimeWarning", () => {
  it("skips lookup when runtime is not node", async () => {
    const warn = vi.fn();
    await emitNodeRuntimeWarning({
      env: {},
      runtime: "bun",
      title: "Gateway runtime",
      warn,
    });
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(mocks.renderSystemNodeWarning).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits warning when system node check returns one", async () => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue({ path: "/usr/bin/node", version: "18.0.0" });
    mocks.renderSystemNodeWarning.mockReturnValue("Node too old");

    await emitNodeRuntimeWarning({
      env: { PATH: "/usr/bin" },
      nodeProgram: "/opt/node",
      runtime: "node",
      title: "Node daemon runtime",
      warn,
    });

    expect(mocks.resolveSystemNodeInfo).toHaveBeenCalledWith({
      env: { PATH: "/usr/bin" },
    });
    expect(mocks.renderSystemNodeWarning).toHaveBeenCalledWith(
      { path: "/usr/bin/node", version: "18.0.0" },
      "/opt/node",
    );
    expect(warn).toHaveBeenCalledWith("Node too old", "Node daemon runtime");
  });

  it("does not emit when warning helper returns null", async () => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.renderSystemNodeWarning.mockReturnValue(null);

    await emitNodeRuntimeWarning({
      env: {},
      nodeProgram: "node",
      runtime: "node",
      title: "Gateway runtime",
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
