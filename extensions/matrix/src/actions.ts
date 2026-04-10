import { Type } from "@sinclair/typebox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { requiresExplicitMatrixDefaultAccount } from "./account-selection.js";
import { resolveDefaultMatrixAccountId, resolveMatrixAccount } from "./matrix/accounts.js";
import {
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
  type ChannelMessageActionName,
  type ChannelMessageToolDiscovery,
  type ChannelToolSend,
  createActionGate,
  readNumberParam,
  readStringParam,
} from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

const MATRIX_PLUGIN_HANDLED_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll-vote",
  "react",
  "reactions",
  "read",
  "edit",
  "delete",
  "pin",
  "unpin",
  "list-pins",
  "set-profile",
  "member-info",
  "channel-info",
  "permissions",
]);

function createMatrixExposedActions(params: {
  gate: ReturnType<typeof createActionGate>;
  encryptionEnabled: boolean;
}) {
  const actions = new Set<ChannelMessageActionName>(["poll", "poll-vote"]);
  if (params.gate("messages")) {
    actions.add("send");
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
  }
  if (params.gate("reactions")) {
    actions.add("react");
    actions.add("reactions");
  }
  if (params.gate("pins")) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }
  if (params.gate("profile")) {
    actions.add("set-profile");
  }
  if (params.gate("memberInfo")) {
    actions.add("member-info");
  }
  if (params.gate("channelInfo")) {
    actions.add("channel-info");
  }
  if (params.encryptionEnabled && params.gate("verification")) {
    actions.add("permissions");
  }
  return actions;
}

function buildMatrixProfileToolSchema(): NonNullable<ChannelMessageToolDiscovery["schema"]> {
  return {
    properties: {
      avatarPath: Type.Optional(
        Type.String({
          description:
            "Local avatar file path for Matrix self-profile update actions. Matrix uploads this file and sets the resulting MXC URI.",
        }),
      ),
      avatarUrl: Type.Optional(
        Type.String({
          description:
            "Profile avatar URL for Matrix self-profile update actions. Matrix accepts mxc:// and http(s) URLs.",
        }),
      ),
      avatar_path: Type.Optional(
        Type.String({
          description:
            "snake_case alias of avatarPath for Matrix self-profile update actions. Matrix uploads this file and sets the resulting MXC URI.",
        }),
      ),
      avatar_url: Type.Optional(
        Type.String({
          description:
            "snake_case alias of avatarUrl for Matrix self-profile update actions. Matrix accepts mxc:// and http(s) URLs.",
        }),
      ),
      displayName: Type.Optional(
        Type.String({
          description: "Profile display name for Matrix self-profile update actions.",
        }),
      ),
      display_name: Type.Optional(
        Type.String({
          description: "snake_case alias of displayName for Matrix self-profile update actions.",
        }),
      ),
    },
  };
}

export const matrixMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const resolvedCfg = cfg as CoreConfig;
    if (!accountId && requiresExplicitMatrixDefaultAccount(resolvedCfg)) {
      return { actions: [], capabilities: [] };
    }
    const account = resolveMatrixAccount({
      accountId: accountId ?? resolveDefaultMatrixAccountId(resolvedCfg),
      cfg: resolvedCfg,
    });
    if (!account.enabled || !account.configured) {
      return { actions: [], capabilities: [] };
    }
    const gate = createActionGate(account.config.actions);
    const actions = createMatrixExposedActions({
      encryptionEnabled: account.config.encryption === true,
      gate,
    });
    const listedActions = [...actions];
    return {
      actions: listedActions,
      capabilities: [],
      schema: listedActions.includes("set-profile") ? buildMatrixProfileToolSchema() : null,
    };
  },
  extractToolSend: ({ args }): ChannelToolSend | null => extractToolSend(args, "sendMessage"),
  handleAction: async (ctx: ChannelMessageActionContext) => {
    const { handleMatrixAction } = await import("./tool-actions.runtime.js");
    const { action, params, cfg, accountId, mediaLocalRoots } = ctx;
    const dispatch = async (actionParams: Record<string, unknown>) =>
      await handleMatrixAction(
        {
          ...actionParams,
          ...(accountId ? { accountId } : {}),
        },
        cfg as CoreConfig,
        { mediaLocalRoots },
      );
    const resolveRoomId = () =>
      readStringParam(params, "roomId") ??
      readStringParam(params, "channelId") ??
      readStringParam(params, "to", { required: true });

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const mediaUrl =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "mediaUrl", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "path", { trim: false });
      const content = readStringParam(params, "message", {
        allowEmpty: true,
        required: !mediaUrl,
      });
      const replyTo = readStringParam(params, "replyTo");
      const threadId = readStringParam(params, "threadId");
      const audioAsVoice =
        typeof params.asVoice === "boolean"
          ? params.asVoice
          : (typeof params.audioAsVoice === "boolean"
            ? params.audioAsVoice
            : undefined);
      return await dispatch({
        action: "sendMessage",
        audioAsVoice,
        content,
        mediaUrl: mediaUrl ?? undefined,
        replyToId: replyTo ?? undefined,
        threadId: threadId ?? undefined,
        to,
      });
    }

    if (action === "poll-vote") {
      return await dispatch({
        ...params,
        action: "pollVote",
      });
    }

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;
      return await dispatch({
        action: "react",
        emoji,
        messageId,
        remove,
        roomId: resolveRoomId(),
      });
    }

    if (action === "reactions") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      return await dispatch({
        action: "reactions",
        limit,
        messageId,
        roomId: resolveRoomId(),
      });
    }

    if (action === "read") {
      const limit = readNumberParam(params, "limit", { integer: true });
      return await dispatch({
        action: "readMessages",
        after: readStringParam(params, "after"),
        before: readStringParam(params, "before"),
        limit,
        roomId: resolveRoomId(),
      });
    }

    if (action === "edit") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const content = readStringParam(params, "message", { required: true });
      return await dispatch({
        action: "editMessage",
        content,
        messageId,
        roomId: resolveRoomId(),
      });
    }

    if (action === "delete") {
      const messageId = readStringParam(params, "messageId", { required: true });
      return await dispatch({
        action: "deleteMessage",
        messageId,
        roomId: resolveRoomId(),
      });
    }

    if (action === "pin" || action === "unpin" || action === "list-pins") {
      const messageId =
        action === "list-pins"
          ? undefined
          : readStringParam(params, "messageId", { required: true });
      return await dispatch({
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        messageId,
        roomId: resolveRoomId(),
      });
    }

    if (action === "set-profile") {
      const avatarPath =
        readStringParam(params, "avatarPath") ??
        readStringParam(params, "path") ??
        readStringParam(params, "filePath");
      return await dispatch({
        action: "setProfile",
        avatarPath,
        avatarUrl: readStringParam(params, "avatarUrl"),
        displayName: readStringParam(params, "displayName") ?? readStringParam(params, "name"),
      });
    }

    if (action === "member-info") {
      const userId = readStringParam(params, "userId", { required: true });
      return await dispatch({
        action: "memberInfo",
        roomId: readStringParam(params, "roomId") ?? readStringParam(params, "channelId"),
        userId,
      });
    }

    if (action === "channel-info") {
      return await dispatch({
        action: "channelInfo",
        roomId: resolveRoomId(),
      });
    }

    if (action === "permissions") {
      const operation = normalizeLowercaseStringOrEmpty(
        readStringParam(params, "operation") ??
          readStringParam(params, "mode") ??
          "verification-list",
      );
      const operationToAction: Record<string, string> = {
        "encryption-status": "encryptionStatus",
        "verification-accept": "verificationAccept",
        "verification-backup-restore": "verificationBackupRestore",
        "verification-backup-status": "verificationBackupStatus",
        "verification-bootstrap": "verificationBootstrap",
        "verification-cancel": "verificationCancel",
        "verification-confirm": "verificationConfirm",
        "verification-confirm-qr": "verificationConfirmQr",
        "verification-generate-qr": "verificationGenerateQr",
        "verification-list": "verificationList",
        "verification-mismatch": "verificationMismatch",
        "verification-recovery-key": "verificationRecoveryKey",
        "verification-request": "verificationRequest",
        "verification-sas": "verificationSas",
        "verification-scan-qr": "verificationScanQr",
        "verification-start": "verificationStart",
        "verification-status": "verificationStatus",
      };
      const resolvedAction = operationToAction[operation];
      if (!resolvedAction) {
        throw new Error(
          `Unsupported Matrix permissions operation: ${operation}. Supported values: ${Object.keys(
            operationToAction,
          ).join(", ")}`,
        );
      }
      return await dispatch({
        ...params,
        action: resolvedAction,
      });
    }

    throw new Error(`Action ${action} is not supported for provider matrix.`);
  },
  supportsAction: ({ action }) => MATRIX_PLUGIN_HANDLED_ACTIONS.has(action),
};
