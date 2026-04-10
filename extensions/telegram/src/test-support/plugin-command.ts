import { vi } from "vitest";

export const pluginCommandMocks = {
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
};

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  executePluginCommand: pluginCommandMocks.executePluginCommand,
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
}));

export function resetPluginCommandMocks() {
  pluginCommandMocks.getPluginCommandSpecs.mockClear();
  pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([]);
  pluginCommandMocks.matchPluginCommand.mockClear();
  pluginCommandMocks.matchPluginCommand.mockReturnValue(null);
  pluginCommandMocks.executePluginCommand.mockClear();
  pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" });
}
