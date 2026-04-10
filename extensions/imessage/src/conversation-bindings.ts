import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type AccountScopedConversationBindingManager,
  type BindingTargetKind,
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
} from "openclaw/plugin-sdk/thread-bindings-runtime";

type IMessageBindingTargetKind = "subagent" | "acp";

type IMessageConversationBindingManager =
  AccountScopedConversationBindingManager<IMessageBindingTargetKind>;

const IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for(
  "openclaw.imessageConversationBindingsState",
);

function toSessionBindingTargetKind(raw: IMessageBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toIMessageTargetKind(raw: BindingTargetKind): IMessageBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

export function createIMessageConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): IMessageConversationBindingManager {
  return createAccountScopedConversationBindingManager({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "imessage",
    stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
    toSessionBindingTargetKind,
    toStoredTargetKind: toIMessageTargetKind,
  });
}

export const __testing = {
  resetIMessageConversationBindingsForTests() {
    resetAccountScopedConversationBindingsForTests({
      stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
    });
  },
};
