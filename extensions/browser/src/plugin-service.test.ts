import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserPluginService } from "./plugin-service.js";

const SERVICE_CONTEXT = {
  config: {},
  logger: console,
  stateDir: "/tmp/openclaw-state",
};

interface StartLazyPluginServiceModuleParams {
  validateOverrideSpecifier?: (specifier: string) => string;
}
interface StartLazyPluginServiceModuleParamsWithValidator {
  validateOverrideSpecifier: (specifier: string) => string;
}

const runtimeMocks = vi.hoisted(() => ({
  startLazyPluginServiceModule: vi.fn(async (_params: StartLazyPluginServiceModuleParams) => null),
}));

vi.mock("openclaw/plugin-sdk/browser-node-runtime", () => ({
  startLazyPluginServiceModule: runtimeMocks.startLazyPluginServiceModule,
}));

describe("createBrowserPluginService", () => {
  beforeEach(() => {
    runtimeMocks.startLazyPluginServiceModule.mockClear();
  });

  function getStartParams(): StartLazyPluginServiceModuleParamsWithValidator {
    const params = runtimeMocks.startLazyPluginServiceModule.mock.calls[0]?.[0];
    if (!params?.validateOverrideSpecifier) {
      throw new Error("expected browser plugin service to pass validateOverrideSpecifier");
    }
    return { validateOverrideSpecifier: params.validateOverrideSpecifier };
  }

  it("passes a browser override validator to the lazy service loader", async () => {
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    expect(params.validateOverrideSpecifier(" ./server.js ")).toBe("./server.js");
  });

  it("rejects unsafe browser override specifiers", async () => {
    const service = createBrowserPluginService();

    await service.start(SERVICE_CONTEXT);

    const params = getStartParams();
    expect(() => params.validateOverrideSpecifier("data:text/javascript,boom")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
    expect(() => params.validateOverrideSpecifier("HTTPS://example.invalid/mod.mjs")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
    expect(() => params.validateOverrideSpecifier("node:fs")).toThrow(
      "Refusing unsafe browser control override specifier",
    );
  });
});
