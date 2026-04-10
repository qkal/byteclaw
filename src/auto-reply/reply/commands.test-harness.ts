import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext } from "./commands-context.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.js";

export function buildCommandTestParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
  options?: {
    workspaceDir?: string;
  },
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandAuthorized: true,
    CommandBody: commandBody,
    CommandSource: "text",
    Provider: "whatsapp",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    cfg,
    commandAuthorized: true,
    ctx,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim(),
  });

  const params: HandleCommandsParams = {
    cfg,
    command,
    contextTokens: 0,
    ctx,
    defaultGroupActivation: () => "mention",
    directives: parseInlineDirectives(commandBody),
    elevated: { allowed: true, enabled: true, failures: [] },
    isGroup: false,
    model: "test-model",
    provider: "whatsapp",
    resolveDefaultThinkingLevel: async () => undefined,
    resolvedReasoningLevel: "off",
    resolvedVerboseLevel: "off",
    sessionKey: "agent:main:main",
    workspaceDir: options?.workspaceDir ?? "/tmp",
  };
  return params;
}
