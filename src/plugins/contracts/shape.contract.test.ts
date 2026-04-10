import { describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../../test/helpers/plugins/contracts-testkit.js";
import { buildAllPluginInspectReports } from "../status.js";

describe("plugin shape compatibility matrix", () => {
  it("keeps legacy hook-only, plain capability, and hybrid capability shapes explicit", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      config,
      id: "lca-legacy",
      name: "LCA Legacy",
      register(api) {
        api.on("before_agent_start", () => ({
          prependContext: "legacy",
        }));
      },
      registry,
    });

    registerVirtualTestPlugin({
      config,
      id: "plain-provider",
      name: "Plain Provider",
      register(api) {
        api.registerProvider({
          auth: [],
          id: "plain-provider",
          label: "Plain Provider",
        });
      },
      registry,
    });

    registerVirtualTestPlugin({
      config,
      id: "hybrid-company",
      name: "Hybrid Company",
      register(api) {
        api.registerProvider({
          auth: [],
          id: "hybrid-company",
          label: "Hybrid Company",
        });
        api.registerWebSearchProvider({
          createTool: () => ({
            description: "Hybrid search",
            parameters: {},
            execute: async () => ({}),
          }),
          credentialPath: "tools.web.search.hybrid-search.apiKey",
          envVars: ["HYBRID_SEARCH_KEY"],
          getCredentialValue: () => "hsk-test",
          hint: "Search the web",
          id: "hybrid-search",
          label: "Hybrid Search",
          placeholder: "hsk_...",
          setCredentialValue(searchConfigTarget, value) {
            searchConfigTarget.apiKey = value;
          },
          signupUrl: "https://example.com/signup",
        });
      },
      registry,
    });

    registerVirtualTestPlugin({
      config,
      id: "channel-demo",
      name: "Channel Demo",
      register(api) {
        api.registerChannel({
          plugin: {
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            id: "channel-demo",
            meta: {
              blurb: "channel demo",
              docsPath: "/channels/channel-demo",
              id: "channel-demo",
              label: "Channel Demo",
              selectionLabel: "Channel Demo",
            },
            outbound: { deliveryMode: "direct" },
          },
        });
      },
      registry,
    });

    const inspect = buildAllPluginInspectReports({
      config,
      report: {
        workspaceDir: "/virtual-workspace",
        ...registry.registry,
      },
    });

    expect(
      inspect.map((entry) => ({
        capabilityMode: entry.capabilityMode,
        id: entry.plugin.id,
        shape: entry.shape,
      })),
    ).toEqual([
      {
        capabilityMode: "none",
        id: "lca-legacy",
        shape: "hook-only",
      },
      {
        capabilityMode: "plain",
        id: "plain-provider",
        shape: "plain-capability",
      },
      {
        capabilityMode: "hybrid",
        id: "hybrid-company",
        shape: "hybrid-capability",
      },
      {
        capabilityMode: "plain",
        id: "channel-demo",
        shape: "plain-capability",
      },
    ]);

    expect(inspect[0]?.usesLegacyBeforeAgentStart).toBe(true);
    expect(inspect.map((entry) => entry.capabilities.map((capability) => capability.kind))).toEqual(
      [[], ["text-inference"], ["text-inference", "web-search"], ["channel"]],
    );
  });
});
