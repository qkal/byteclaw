import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

type AutoThreadResolver = (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  toolContext?: Record<string, unknown>;
  replyToId?: string;
}) => string | undefined;

interface OutboundThreadContext {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  toolContext?: Record<string, unknown>;
  resolveAutoThreadId?: AutoThreadResolver;
}

function resolveOutboundThreadId(
  actionParams: Record<string, unknown>,
  context: OutboundThreadContext,
): string | undefined {
  const explicit = typeof actionParams.threadId === "string" ? actionParams.threadId : undefined;
  const replyToId = typeof actionParams.replyTo === "string" ? actionParams.replyTo : undefined;
  const resolved =
    explicit ??
    context.resolveAutoThreadId?.({
      accountId: context.accountId,
      cfg: context.cfg,
      replyToId,
      to: context.to,
      toolContext: context.toolContext,
    });
  if (resolved && !actionParams.threadId) {
    actionParams.threadId = resolved;
  }
  return resolved ?? undefined;
}

export function createOutboundThreadingMock() {
  return {
    prepareOutboundMirrorRoute: vi.fn(
      async ({
        actionParams,
        cfg,
        to,
        accountId,
        toolContext,
        agentId,
        resolveAutoThreadId,
      }: {
        actionParams: Record<string, unknown>;
        cfg: OpenClawConfig;
        to: string;
        accountId?: string | null;
        toolContext?: Record<string, unknown>;
        agentId?: string;
        resolveAutoThreadId?: AutoThreadResolver;
      }) => {
        const resolvedThreadId = resolveOutboundThreadId(actionParams, {
          accountId,
          cfg,
          resolveAutoThreadId,
          to,
          toolContext,
        });
        if (agentId) {
          actionParams.__agentId = agentId;
        }
        return {
          outboundRoute: null,
          resolvedThreadId,
        };
      },
    ),
    resolveAndApplyOutboundThreadId: vi.fn(resolveOutboundThreadId),
  };
}
