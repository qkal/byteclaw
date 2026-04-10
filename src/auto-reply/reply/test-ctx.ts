import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";

export function buildTestCtx(overrides: Partial<MsgContext> = {}): FinalizedMsgContext {
  return finalizeInboundContext({
    Body: "",
    ChatType: "direct",
    CommandAuthorized: false,
    CommandBody: "",
    CommandSource: "text",
    From: "whatsapp:+1000",
    Provider: "whatsapp",
    Surface: "whatsapp",
    To: "whatsapp:+2000",
    ...overrides,
  });
}
