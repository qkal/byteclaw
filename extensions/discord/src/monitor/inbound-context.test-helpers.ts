import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";

export function buildFinalizedDiscordDirectInboundContext() {
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig: null,
    guildInfo: null,
    isGuild: false,
    sender: { id: "U1", name: "Alice", tag: "alice" },
  });

  return finalizeInboundContext({
    AccountId: "default",
    Body: "hi",
    BodyForAgent: "hi",
    ChatType: "direct",
    CommandAuthorized: true,
    CommandBody: "hi",
    ConversationLabel: "Alice",
    From: "discord:U1",
    GroupSystemPrompt: groupSystemPrompt,
    MessageSid: "m1",
    OriginatingChannel: "discord",
    OriginatingTo: "user:U1",
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord",
    RawBody: "hi",
    SenderId: "U1",
    SenderName: "Alice",
    SenderUsername: "alice",
    SessionKey: "agent:main:discord:direct:u1",
    Surface: "discord",
    To: "user:U1",
    UntrustedContext: untrustedContext,
    WasMentioned: false,
  });
}
