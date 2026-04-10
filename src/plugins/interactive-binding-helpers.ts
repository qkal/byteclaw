import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import type { PluginConversationBindingRequestParams } from "./types.js";

interface RegisteredInteractiveMetadata {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
}

type PluginBindingConversation = Parameters<
  typeof requestPluginConversationBinding
>[0]["conversation"];

export function createInteractiveConversationBindingHelpers(params: {
  registration: RegisteredInteractiveMetadata;
  senderId?: string;
  conversation: PluginBindingConversation;
}) {
  const { registration, senderId, conversation } = params;
  const {pluginRoot} = registration;

  return {
    detachConversationBinding: async () => {
      if (!pluginRoot) {
        return { removed: false };
      }
      return detachPluginConversationBinding({
        conversation,
        pluginRoot,
      });
    },
    getCurrentConversationBinding: async () => {
      if (!pluginRoot) {
        return null;
      }
      return getCurrentPluginConversationBinding({
        conversation,
        pluginRoot,
      });
    },
    requestConversationBinding: async (binding: PluginConversationBindingRequestParams = {}) => {
      if (!pluginRoot) {
        return {
          message: "This interaction cannot bind the current conversation.",
          status: "error" as const,
        };
      }
      return requestPluginConversationBinding({
        binding,
        conversation,
        pluginId: registration.pluginId,
        pluginName: registration.pluginName,
        pluginRoot,
        requestedBySenderId: senderId,
      });
    },
  };
}
