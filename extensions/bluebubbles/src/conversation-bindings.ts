import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type AccountScopedConversationBindingManager,
  type BindingTargetKind,
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
} from "openclaw/plugin-sdk/thread-bindings-runtime";

type BlueBubblesBindingTargetKind = "subagent" | "acp";

type BlueBubblesConversationBindingManager =
  AccountScopedConversationBindingManager<BlueBubblesBindingTargetKind>;

const BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for(
  "openclaw.bluebubblesConversationBindingsState",
);

function toSessionBindingTargetKind(raw: BlueBubblesBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toBlueBubblesTargetKind(raw: BindingTargetKind): BlueBubblesBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

export function createBlueBubblesConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): BlueBubblesConversationBindingManager {
  return createAccountScopedConversationBindingManager({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "bluebubbles",
    stateKey: BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY,
    toSessionBindingTargetKind,
    toStoredTargetKind: toBlueBubblesTargetKind,
  });
}

export const __testing = {
  resetBlueBubblesConversationBindingsForTests() {
    resetAccountScopedConversationBindingsForTests({
      stateKey: BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY,
    });
  },
};
