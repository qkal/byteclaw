import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

type FeishuSubagentHooksModule = typeof import("./api.js");

let feishuSubagentHooksPromise: Promise<FeishuSubagentHooksModule> | null = null;

function loadFeishuSubagentHooksModule() {
  feishuSubagentHooksPromise ??= import("./api.js");
  return feishuSubagentHooksPromise;
}

function registerFeishuDocTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerFeishuDocTools",
    specifier: "./api.js",
  });
  register(api);
}

function registerFeishuChatTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerFeishuChatTools",
    specifier: "./api.js",
  });
  register(api);
}

function registerFeishuWikiTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerFeishuWikiTools",
    specifier: "./api.js",
  });
  register(api);
}

function registerFeishuDriveTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerFeishuDriveTools",
    specifier: "./api.js",
  });
  register(api);
}

function registerFeishuPermTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerFeishuPermTools",
    specifier: "./api.js",
  });
  register(api);
}

function registerFeishuBitableTools(api: OpenClawPluginApi) {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    exportName: "registerFeishuBitableTools",
    specifier: "./api.js",
  });
  register(api);
}

export default defineBundledChannelEntry({
  description: "Feishu/Lark channel plugin",
  id: "feishu",
  importMetaUrl: import.meta.url,
  name: "Feishu",
  plugin: {
    exportName: "feishuPlugin",
    specifier: "./api.js",
  },
  registerFull(api) {
    api.on("subagent_spawning", async (event, ctx) => {
      const { handleFeishuSubagentSpawning } = await loadFeishuSubagentHooksModule();
      return await handleFeishuSubagentSpawning(event, ctx);
    });
    api.on("subagent_delivery_target", async (event) => {
      const { handleFeishuSubagentDeliveryTarget } = await loadFeishuSubagentHooksModule();
      return handleFeishuSubagentDeliveryTarget(event);
    });
    api.on("subagent_ended", async (event) => {
      const { handleFeishuSubagentEnded } = await loadFeishuSubagentHooksModule();
      handleFeishuSubagentEnded(event);
    });
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
  },
  runtime: {
    exportName: "setFeishuRuntime",
    specifier: "./runtime-api.js",
  },
  secrets: {
    exportName: "channelSecrets",
    specifier: "./secret-contract-api.js",
  },
});
