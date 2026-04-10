import type { ChannelPlugin } from "../channels/plugins/types.js";

export function makeDirectPlugin(params: {
  id: string;
  label: string;
  docsPath: string;
  config: ChannelPlugin["config"];
}): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: params.config,
    id: params.id,
    meta: {
      blurb: "test",
      docsPath: params.docsPath,
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
    },
  };
}
