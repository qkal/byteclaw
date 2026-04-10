import { describe, expect, it } from "vitest";
import { capturePluginRegistration } from "./captured-registration.js";
import type { AnyAgentTool } from "./types.js";

describe("captured plugin registration", () => {
  it("keeps a complete plugin API surface available while capturing supported capabilities", () => {
    const capturedTool = {
      description: "Captured tool",
      execute: async () => ({ content: [], details: {} }),
      name: "captured-tool",
      parameters: {},
    } as unknown as AnyAgentTool;
    const captured = capturePluginRegistration({
      register(api) {
        api.registerTool(capturedTool);
        api.registerProvider({
          auth: [],
          id: "captured-provider",
          label: "Captured Provider",
        });
        api.registerChannel({
          plugin: {
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            id: "captured-channel",
            meta: {
              blurb: "captured channel",
              docsPath: "/channels/captured-channel",
              id: "captured-channel",
              label: "Captured Channel",
              selectionLabel: "Captured Channel",
            },
            outbound: { deliveryMode: "direct" },
          },
        });
        api.registerHook("message_received", () => {});
        api.registerCommand({
          description: "Captured command",
          handler: async () => ({ text: "ok" }),
          name: "captured-command",
        });
      },
    });

    expect(captured.tools.map((tool) => tool.name)).toEqual(["captured-tool"]);
    expect(captured.providers.map((provider) => provider.id)).toEqual(["captured-provider"]);
    expect(captured.api.registerMemoryEmbeddingProvider).toBeTypeOf("function");
  });
});
