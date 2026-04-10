import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveProviderModelPickerFlowContributions,
  resolveProviderSetupFlowContributions,
} from "./provider-flow.js";

const resolveProviderWizardOptions = vi.hoisted(() => vi.fn(() => []));
const resolveProviderModelPickerEntries = vi.hoisted(() => vi.fn(() => []));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderModelPickerEntries,
  resolveProviderWizardOptions,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders,
}));

describe("provider flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses setup mode when resolving docs for setup contributions", () => {
    resolveProviderWizardOptions.mockReturnValue([
      {
        groupId: "sglang",
        groupLabel: "SGLang",
        label: "SGLang",
        value: "provider-plugin:sglang:custom",
      },
    ] as never);
    resolvePluginProviders.mockReturnValue([
      { docsPath: "/providers/sglang", id: "sglang" },
    ] as never);

    const contributions = resolveProviderSetupFlowContributions({
      config: {},
      env: process.env,
      workspaceDir: "/tmp/workspace",
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      mode: "setup",
      workspaceDir: "/tmp/workspace",
    });
    expect(contributions[0]?.option.docs).toEqual({ path: "/providers/sglang" });
    expect(contributions[0]?.source).toBe("runtime");
  });

  it("uses setup mode when resolving docs for runtime model-picker contributions", () => {
    resolveProviderModelPickerEntries.mockReturnValue([
      {
        label: "vLLM",
        value: "provider-plugin:vllm:custom",
      },
    ] as never);
    resolvePluginProviders.mockReturnValue([{ docsPath: "/providers/vllm", id: "vllm" }] as never);

    const contributions = resolveProviderModelPickerFlowContributions({
      config: {},
      env: process.env,
      workspaceDir: "/tmp/workspace",
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      mode: "setup",
      workspaceDir: "/tmp/workspace",
    });
    expect(contributions[0]?.option.docs).toEqual({ path: "/providers/vllm" });
  });
});
