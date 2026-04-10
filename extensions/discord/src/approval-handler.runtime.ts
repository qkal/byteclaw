import {
  Button,
  type MessagePayloadObject,
  Row,
  Separator,
  TextDisplay,
  type TopLevelComponents,
  serializePayload,
} from "@buape/carbon";
import { ButtonStyle, Routes } from "discord-api-types/v10";
import type {
  ChannelApprovalCapabilityHandlerContext,
  ExecApprovalExpiredView,
  ExecApprovalPendingView,
  ExecApprovalResolvedView,
  PendingApprovalView,
  PluginApprovalExpiredView,
  PluginApprovalPendingView,
  PluginApprovalResolvedView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ExecApprovalActionDescriptor,
  ExecApprovalDecision,
} from "openclaw/plugin-sdk/infra-runtime";
import { logDebug, logError, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
import { isDiscordExecApprovalClientEnabled } from "./exec-approvals.js";
import { createDiscordClient, stripUndefinedFields } from "./send.shared.js";
import { DiscordUiContainer } from "./ui.js";

interface PendingApproval {
  discordMessageId: string;
  discordChannelId: string;
}
interface DiscordPendingDelivery {
  body: ReturnType<typeof stripUndefinedFields>;
}
interface PreparedDeliveryTarget {
  discordChannelId: string;
  recipientUserId?: string;
}

export interface DiscordApprovalHandlerContext {
  token: string;
  config: DiscordExecApprovalConfig;
}

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: DiscordApprovalHandlerContext;
} | null {
  const context = params.context as DiscordApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.token || !accountId) {
    return null;
  }
  return { accountId, context };
}

class ExecApprovalContainer extends DiscordUiContainer {
  constructor(params: {
    cfg: OpenClawConfig;
    accountId: string;
    title: string;
    description?: string;
    commandPreview: string;
    commandSecondaryPreview?: string | null;
    metadataLines?: string[];
    actionRow?: Row<Button>;
    footer?: string;
    accentColor?: string;
  }) {
    const components: (TextDisplay | Separator | Row<Button>)[] = [
      new TextDisplay(`## ${params.title}`),
    ];
    if (params.description) {
      components.push(new TextDisplay(params.description));
    }
    components.push(new Separator({ divider: true, spacing: "small" }));
    components.push(new TextDisplay(`### Command\n\`\`\`\n${params.commandPreview}\n\`\`\``));
    if (params.commandSecondaryPreview) {
      components.push(
        new TextDisplay(`### Shell Preview\n\`\`\`\n${params.commandSecondaryPreview}\n\`\`\``),
      );
    }
    if (params.metadataLines?.length) {
      components.push(new TextDisplay(params.metadataLines.join("\n")));
    }
    if (params.actionRow) {
      components.push(params.actionRow);
    }
    if (params.footer) {
      components.push(new Separator({ divider: false, spacing: "small" }));
      components.push(new TextDisplay(`-# ${params.footer}`));
    }
    super({
      accentColor: params.accentColor,
      accountId: params.accountId,
      cfg: params.cfg,
      components,
    });
  }
}

class ExecApprovalActionButton extends Button {
  customId: string;
  label: string;
  style: ButtonStyle;

  constructor(params: { approvalId: string; descriptor: ExecApprovalActionDescriptor }) {
    super();
    this.customId = buildExecApprovalCustomId(params.approvalId, params.descriptor.decision);
    this.label = params.descriptor.label;
    this.style =
      params.descriptor.style === "success"
        ? ButtonStyle.Success
        : params.descriptor.style === "primary"
          ? ButtonStyle.Primary
          : params.descriptor.style === "danger"
            ? ButtonStyle.Danger
            : ButtonStyle.Secondary;
  }
}

class ExecApprovalActionRow extends Row<Button> {
  constructor(params: { approvalId: string; actions: readonly ExecApprovalActionDescriptor[] }) {
    super(
      params.actions.map(
        (descriptor) => new ExecApprovalActionButton({ approvalId: params.approvalId, descriptor }),
      ),
    );
  }
}

function createApprovalActionRow(view: PendingApprovalView): Row<Button> {
  return new ExecApprovalActionRow({
    actions: view.actions,
    approvalId: view.approvalId,
  });
}

function buildApprovalMetadataLines(
  metadata: readonly { label: string; value: string }[],
): string[] {
  return metadata.map((item) => `- ${item.label}: ${item.value}`);
}

function buildExecApprovalPayload(container: DiscordUiContainer): MessagePayloadObject {
  const components: TopLevelComponents[] = [container];
  return { components };
}

function formatCommandPreview(commandText: string, maxChars: number): string {
  const commandRaw =
    commandText.length > maxChars ? `${commandText.slice(0, maxChars)}...` : commandText;
  return commandRaw.replace(/`/g, "\u200b`");
}

function formatOptionalCommandPreview(
  commandText: string | null | undefined,
  maxChars: number,
): string | null {
  if (!commandText) {
    return null;
  }
  return formatCommandPreview(commandText, maxChars);
}

function resolveCommandPreviews(
  commandText: string,
  commandPreview: string | null | undefined,
  maxChars: number,
  secondaryMaxChars: number,
): { commandPreview: string; commandSecondaryPreview: string | null } {
  return {
    commandPreview: formatCommandPreview(commandText, maxChars),
    commandSecondaryPreview: formatOptionalCommandPreview(commandPreview, secondaryMaxChars),
  };
}

function createExecApprovalRequestContainer(params: {
  view: ExecApprovalPendingView;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveCommandPreviews(
    params.view.commandText,
    params.view.commandPreview,
    1000,
    500,
  );
  const expiresAtSeconds = Math.max(0, Math.floor(params.view.expiresAtMs / 1000));

  return new ExecApprovalContainer({
    accentColor: "#FFA500",
    accountId: params.accountId,
    actionRow: params.actionRow,
    cfg: params.cfg,
    commandPreview,
    commandSecondaryPreview,
    description: "A command needs your approval.",
    footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.view.approvalId}`,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    title: "Exec Approval Required",
  });
}

function createPluginApprovalRequestContainer(params: {
  view: PluginApprovalPendingView;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): ExecApprovalContainer {
  const expiresAtSeconds = Math.max(0, Math.floor(params.view.expiresAtMs / 1000));
  const { severity } = params.view;
  const accentColor =
    severity === "critical" ? "#ED4245" : severity === "info" ? "#5865F2" : "#FAA61A";
  return new ExecApprovalContainer({
    accentColor,
    accountId: params.accountId,
    actionRow: params.actionRow,
    cfg: params.cfg,
    commandPreview: formatCommandPreview(params.view.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.view.description, 1000),
    description: "A plugin action needs your approval.",
    footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.view.approvalId}`,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    title: "Plugin Approval Required",
  });
}

function createExecResolvedContainer(params: {
  view: ExecApprovalResolvedView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveCommandPreviews(
    params.view.commandText,
    params.view.commandPreview,
    500,
    300,
  );
  const decisionLabel =
    params.view.decision === "allow-once"
      ? "Allowed (once)"
      : params.view.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";
  const accentColor =
    params.view.decision === "deny"
      ? "#ED4245"
      : params.view.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";

  return new ExecApprovalContainer({
    accentColor,
    accountId: params.accountId,
    cfg: params.cfg,
    commandPreview,
    commandSecondaryPreview,
    description: params.view.resolvedBy ? `Resolved by ${params.view.resolvedBy}` : "Resolved",
    footer: `ID: ${params.view.approvalId}`,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    title: `Exec Approval: ${decisionLabel}`,
  });
}

function createPluginResolvedContainer(params: {
  view: PluginApprovalResolvedView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const decisionLabel =
    params.view.decision === "allow-once"
      ? "Allowed (once)"
      : params.view.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";
  const accentColor =
    params.view.decision === "deny"
      ? "#ED4245"
      : params.view.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";

  return new ExecApprovalContainer({
    accentColor,
    accountId: params.accountId,
    cfg: params.cfg,
    commandPreview: formatCommandPreview(params.view.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.view.description, 1000),
    description: params.view.resolvedBy ? `Resolved by ${params.view.resolvedBy}` : "Resolved",
    footer: `ID: ${params.view.approvalId}`,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    title: `Plugin Approval: ${decisionLabel}`,
  });
}

function createExecExpiredContainer(params: {
  view: ExecApprovalExpiredView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveCommandPreviews(
    params.view.commandText,
    params.view.commandPreview,
    500,
    300,
  );
  return new ExecApprovalContainer({
    accentColor: "#99AAB5",
    accountId: params.accountId,
    cfg: params.cfg,
    commandPreview,
    commandSecondaryPreview,
    description: "This approval request has expired.",
    footer: `ID: ${params.view.approvalId}`,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    title: "Exec Approval: Expired",
  });
}

function createPluginExpiredContainer(params: {
  view: PluginApprovalExpiredView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  return new ExecApprovalContainer({
    accentColor: "#99AAB5",
    accountId: params.accountId,
    cfg: params.cfg,
    commandPreview: formatCommandPreview(params.view.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.view.description, 1000),
    description: "This approval request has expired.",
    footer: `ID: ${params.view.approvalId}`,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    title: "Plugin Approval: Expired",
  });
}

export function buildExecApprovalCustomId(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  return [`execapproval:id=${encodeURIComponent(approvalId)}`, `action=${action}`].join(";");
}

async function updateMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  channelId: string;
  messageId: string;
  container: DiscordUiContainer;
}): Promise<void> {
  try {
    const { rest, request: discordRequest } = createDiscordClient(
      { accountId: params.accountId, token: params.token },
      params.cfg,
    );
    const payload = buildExecApprovalPayload(params.container);
    await discordRequest(
      () =>
        rest.patch(Routes.channelMessage(params.channelId, params.messageId), {
          body: stripUndefinedFields(serializePayload(payload)),
        }),
      "update-approval",
    );
  } catch (error) {
    logError(`discord approvals: failed to update message: ${String(error)}`);
  }
}

async function finalizeMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  cleanupAfterResolve?: boolean;
  channelId: string;
  messageId: string;
  container: DiscordUiContainer;
}): Promise<void> {
  if (!params.cleanupAfterResolve) {
    await updateMessage(params);
    return;
  }
  try {
    const { rest, request: discordRequest } = createDiscordClient(
      { accountId: params.accountId, token: params.token },
      params.cfg,
    );
    await discordRequest(
      () => rest.delete(Routes.channelMessage(params.channelId, params.messageId)) as Promise<void>,
      "delete-approval",
    );
  } catch (error) {
    logError(`discord approvals: failed to delete message: ${String(error)}`);
    await updateMessage(params);
  }
}

export const discordApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  DiscordPendingDelivery,
  PreparedDeliveryTarget,
  PendingApproval,
  never
>({
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isDiscordExecApprovalClientEnabled({
            accountId: resolved.accountId,
            cfg: params.cfg,
            configOverride: resolved.context.config,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? shouldHandleDiscordApprovalRequest({
            accountId: resolved.accountId,
            cfg: params.cfg,
            configOverride: resolved.context.config,
            request: params.request,
          })
        : false;
    },
  },
  eventKinds: ["exec", "plugin"],
  observe: {
    onDelivered: ({ plannedTarget, preparedTarget, request }) => {
      if (plannedTarget.surface === "origin") {
        logDebug(
          `discord approvals: sent approval ${request.id} to channel ${preparedTarget.target.discordChannelId}`,
        );
        return;
      }
      logDebug(`discord approvals: sent approval ${request.id} to user ${plannedTarget.target.to}`);
    },
    onDeliveryError: ({ error, plannedTarget }) => {
      if (plannedTarget.surface === "origin") {
        logError(`discord approvals: failed to send to channel: ${String(error)}`);
        return;
      }
      logError(
        `discord approvals: failed to notify user ${plannedTarget.target.to}: ${String(error)}`,
      );
    },
    onDuplicateSkipped: ({ preparedTarget, request }) => {
      logDebug(
        `discord approvals: skipping duplicate approval ${request.id} for channel ${preparedTarget.dedupeKey}`,
      );
    },
  },
  presentation: {
    buildExpiredResult: ({ cfg, accountId, context, view }) => {
      const resolvedContext = resolveHandlerContext({ accountId, cfg, context });
      if (!resolvedContext) {
        return { kind: "delete" } as const;
      }
      const container =
        view.approvalKind === "plugin"
          ? createPluginExpiredContainer({
              view,
              cfg,
              accountId: resolvedContext.accountId,
            })
          : createExecExpiredContainer({
              view,
              cfg,
              accountId: resolvedContext.accountId,
            });
      return { kind: "update", payload: container } as const;
    },
    buildPendingPayload: ({ cfg, accountId, context, view }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return { body: {} };
      }
      const actionRow = createApprovalActionRow(view);
      const container =
        view.approvalKind === "plugin"
          ? createPluginApprovalRequestContainer({
              view,
              cfg,
              accountId: resolved.accountId,
              actionRow,
            })
          : createExecApprovalRequestContainer({
              view,
              cfg,
              accountId: resolved.accountId,
              actionRow,
            });
      return {
        body: stripUndefinedFields(serializePayload(buildExecApprovalPayload(container))),
      };
    },
    buildResolvedResult: ({ cfg, accountId, context, view }) => {
      const resolvedContext = resolveHandlerContext({ accountId, cfg, context });
      if (!resolvedContext) {
        return { kind: "delete" } as const;
      }
      const container =
        view.approvalKind === "plugin"
          ? createPluginResolvedContainer({
              view,
              cfg,
              accountId: resolvedContext.accountId,
            })
          : createExecResolvedContainer({
              view,
              cfg,
              accountId: resolvedContext.accountId,
            });
      return { kind: "update", payload: container } as const;
    },
  },
  resolveApprovalKind: (request) => (request.id.startsWith("plugin:") ? "plugin" : "exec"),
  transport: {
    deliverPending: async ({
      cfg,
      accountId,
      context,
      plannedTarget,
      preparedTarget,
      pendingPayload,
    }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return null;
      }
      const { rest, request: discordRequest } = createDiscordClient(
        { accountId: resolved.accountId, token: resolved.context.token },
        cfg,
      );
      const message = (await discordRequest(
        () =>
          rest.post(Routes.channelMessages(preparedTarget.discordChannelId), {
            body: pendingPayload.body,
          }) as Promise<{ id: string; channel_id: string }>,
        plannedTarget.surface === "origin" ? "send-approval-channel" : "send-approval",
      )) as { id: string; channel_id: string };
      if (!message?.id) {
        if (plannedTarget.surface === "origin") {
          logError("discord approvals: failed to send to channel");
        } else if (preparedTarget.recipientUserId) {
          logError(
            `discord approvals: failed to send message to user ${preparedTarget.recipientUserId}`,
          );
        }
        return null;
      }
      return {
        discordChannelId: preparedTarget.discordChannelId,
        discordMessageId: message.id,
      };
    },
    prepareTarget: async ({ cfg, accountId, context, plannedTarget }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return null;
      }
      if (plannedTarget.surface === "origin") {
        const destinationId =
          typeof plannedTarget.target.threadId === "string" &&
          plannedTarget.target.threadId.trim().length > 0
            ? plannedTarget.target.threadId.trim()
            : plannedTarget.target.to;
        return {
          dedupeKey: destinationId,
          target: {
            discordChannelId: destinationId,
          },
        };
      }
      const { rest, request: discordRequest } = createDiscordClient(
        { accountId: resolved.accountId, token: resolved.context.token },
        cfg,
      );
      const userId = plannedTarget.target.to;
      const dmChannel = (await discordRequest(
        () =>
          rest.post(Routes.userChannels(), {
            body: { recipient_id: userId },
          }) as Promise<{ id: string }>,
        "dm-channel",
      )) as { id: string };
      if (!dmChannel?.id) {
        logError(`discord approvals: failed to create DM for user ${userId}`);
        return null;
      }
      return {
        dedupeKey: dmChannel.id,
        target: {
          discordChannelId: dmChannel.id,
          recipientUserId: userId,
        },
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload, phase }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return;
      }
      const container = payload as DiscordUiContainer;
      await finalizeMessage({
        accountId: resolved.accountId,
        cfg,
        channelId: entry.discordChannelId,
        cleanupAfterResolve:
          phase === "resolved" ? resolved.context.config.cleanupAfterResolve : false,
        container,
        messageId: entry.discordMessageId,
        token: resolved.context.token,
      });
    },
  },
});
