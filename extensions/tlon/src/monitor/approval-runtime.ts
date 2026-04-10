import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { PendingApproval, TlonSettingsStore } from "../settings.js";
import { normalizeShip } from "../targets.js";
import { sendDm } from "../urbit/send.js";
import type { UrbitSSEClient } from "../urbit/sse-client.js";
import {
  findPendingApproval,
  formatApprovalConfirmation,
  formatApprovalRequest,
  formatBlockedList,
  formatPendingList,
  parseAdminCommand,
  parseApprovalResponse,
  removePendingApproval,
} from "./approval.js";

type TlonApprovalApi = Pick<UrbitSSEClient, "poke" | "scry">;

type ApprovedMessageProcessor = (approval: PendingApproval) => Promise<void>;

export function createTlonApprovalRuntime(params: {
  api: TlonApprovalApi;
  runtime: RuntimeEnv;
  botShipName: string;
  getPendingApprovals: () => PendingApproval[];
  setPendingApprovals: (approvals: PendingApproval[]) => void;
  getCurrentSettings: () => TlonSettingsStore;
  setCurrentSettings: (settings: TlonSettingsStore) => void;
  getEffectiveDmAllowlist: () => string[];
  setEffectiveDmAllowlist: (ships: string[]) => void;
  getEffectiveOwnerShip: () => string | null;
  processApprovedMessage: ApprovedMessageProcessor;
  refreshWatchedChannels: () => Promise<number>;
}) {
  const {
    api,
    runtime,
    botShipName,
    getPendingApprovals,
    setPendingApprovals,
    getCurrentSettings,
    setCurrentSettings,
    getEffectiveDmAllowlist,
    setEffectiveDmAllowlist,
    getEffectiveOwnerShip,
    processApprovedMessage,
    refreshWatchedChannels,
  } = params;

  const savePendingApprovals = async (): Promise<void> => {
    try {
      await api.poke({
        app: "settings",
        json: {
          "put-entry": {
            "bucket-key": "tlon",
            desk: "moltbot",
            "entry-key": "pendingApprovals",
            value: JSON.stringify(getPendingApprovals()),
          },
        },
        mark: "settings-event",
      });
    } catch (error) {
      runtime.error?.(`[tlon] Failed to save pending approvals: ${String(error)}`);
    }
  };

  const addToDmAllowlist = async (ship: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    const nextAllowlist = getEffectiveDmAllowlist().includes(normalizedShip)
      ? getEffectiveDmAllowlist()
      : [...getEffectiveDmAllowlist(), normalizedShip];
    setEffectiveDmAllowlist(nextAllowlist);
    try {
      await api.poke({
        app: "settings",
        json: {
          "put-entry": {
            "bucket-key": "tlon",
            desk: "moltbot",
            "entry-key": "dmAllowlist",
            value: nextAllowlist,
          },
        },
        mark: "settings-event",
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to dmAllowlist`);
    } catch (error) {
      runtime.error?.(`[tlon] Failed to update dmAllowlist: ${String(error)}`);
    }
  };

  const addToChannelAllowlist = async (ship: string, channelNest: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    const currentSettings = getCurrentSettings();
    const channelRules = currentSettings.channelRules ?? {};
    const rule = channelRules[channelNest] ?? { allowedShips: [], mode: "restricted" };
    const allowedShips = [...(rule.allowedShips ?? [])];

    if (!allowedShips.includes(normalizedShip)) {
      allowedShips.push(normalizedShip);
    }

    const updatedRules = {
      ...channelRules,
      [channelNest]: { ...rule, allowedShips },
    };
    setCurrentSettings({ ...currentSettings, channelRules: updatedRules });

    try {
      await api.poke({
        app: "settings",
        json: {
          "put-entry": {
            "bucket-key": "tlon",
            desk: "moltbot",
            "entry-key": "channelRules",
            value: JSON.stringify(updatedRules),
          },
        },
        mark: "settings-event",
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to ${channelNest} allowlist`);
    } catch (error) {
      runtime.error?.(`[tlon] Failed to update channelRules: ${String(error)}`);
    }
  };

  const blockShip = async (ship: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    try {
      await api.poke({
        app: "chat",
        json: { ship: normalizedShip },
        mark: "chat-block-ship",
      });
      runtime.log?.(`[tlon] Blocked ship ${normalizedShip}`);
    } catch (error) {
      runtime.error?.(`[tlon] Failed to block ship ${normalizedShip}: ${String(error)}`);
    }
  };

  const isShipBlocked = async (ship: string): Promise<boolean> => {
    const normalizedShip = normalizeShip(ship);
    try {
      const blocked = (await api.scry("/chat/blocked.json")) as string[] | undefined;
      return (
        Array.isArray(blocked) && blocked.some((item) => normalizeShip(item) === normalizedShip)
      );
    } catch (error) {
      runtime.log?.(`[tlon] Failed to check blocked list: ${String(error)}`);
      return false;
    }
  };

  const getBlockedShips = async (): Promise<string[]> => {
    try {
      const blocked = (await api.scry("/chat/blocked.json")) as string[] | undefined;
      return Array.isArray(blocked) ? blocked : [];
    } catch (error) {
      runtime.log?.(`[tlon] Failed to get blocked list: ${String(error)}`);
      return [];
    }
  };

  const unblockShip = async (ship: string): Promise<boolean> => {
    const normalizedShip = normalizeShip(ship);
    try {
      await api.poke({
        app: "chat",
        json: { ship: normalizedShip },
        mark: "chat-unblock-ship",
      });
      runtime.log?.(`[tlon] Unblocked ship ${normalizedShip}`);
      return true;
    } catch (error) {
      runtime.error?.(`[tlon] Failed to unblock ship ${normalizedShip}: ${String(error)}`);
      return false;
    }
  };

  const sendOwnerNotification = async (message: string): Promise<void> => {
    const ownerShip = getEffectiveOwnerShip();
    if (!ownerShip) {
      runtime.log?.("[tlon] No ownerShip configured, cannot send notification");
      return;
    }
    try {
      await sendDm({
        api,
        fromShip: botShipName,
        text: message,
        toShip: ownerShip,
      });
      runtime.log?.(`[tlon] Sent notification to owner ${ownerShip}`);
    } catch (error) {
      runtime.error?.(`[tlon] Failed to send notification to owner: ${String(error)}`);
    }
  };

  const queueApprovalRequest = async (approval: PendingApproval): Promise<void> => {
    if (await isShipBlocked(approval.requestingShip)) {
      runtime.log?.(`[tlon] Ignoring request from blocked ship ${approval.requestingShip}`);
      return;
    }

    const approvals = getPendingApprovals();
    const existingIndex = approvals.findIndex(
      (item) =>
        item.type === approval.type &&
        item.requestingShip === approval.requestingShip &&
        (approval.type !== "channel" || item.channelNest === approval.channelNest) &&
        (approval.type !== "group" || item.groupFlag === approval.groupFlag),
    );

    if (existingIndex !== -1) {
      const existing = approvals[existingIndex];
      if (approval.originalMessage) {
        existing.originalMessage = approval.originalMessage;
        existing.messagePreview = approval.messagePreview;
      }
      runtime.log?.(
        `[tlon] Updated existing approval for ${approval.requestingShip} (${approval.type}) - re-sending notification`,
      );
      await savePendingApprovals();
      await sendOwnerNotification(formatApprovalRequest(existing));
      return;
    }

    setPendingApprovals([...approvals, approval]);
    await savePendingApprovals();
    await sendOwnerNotification(formatApprovalRequest(approval));
    runtime.log?.(
      `[tlon] Queued approval request: ${approval.id} (${approval.type} from ${approval.requestingShip})`,
    );
  };

  const handleApprovalResponse = async (text: string): Promise<boolean> => {
    const parsed = parseApprovalResponse(text);
    if (!parsed) {
      return false;
    }

    const approval = findPendingApproval(getPendingApprovals(), parsed.id);
    if (!approval) {
      await sendOwnerNotification(
        `No pending approval found${parsed.id ? ` for ID: ${parsed.id}` : ""}`,
      );
      return true;
    }

    if (parsed.action === "approve") {
      switch (approval.type) {
        case "dm": {
          await addToDmAllowlist(approval.requestingShip);
          if (approval.originalMessage) {
            runtime.log?.(
              `[tlon] Processing original message from ${approval.requestingShip} after approval`,
            );
            await processApprovedMessage(approval);
          }
          break;
        }
        case "channel": {
          if (approval.channelNest) {
            await addToChannelAllowlist(approval.requestingShip, approval.channelNest);
            if (approval.originalMessage) {
              runtime.log?.(
                `[tlon] Processing original message from ${approval.requestingShip} in ${approval.channelNest} after approval`,
              );
              await processApprovedMessage(approval);
            }
          }
          break;
        }
        case "group": {
          if (approval.groupFlag) {
            try {
              await api.poke({
                app: "groups",
                json: {
                  flag: approval.groupFlag,
                  "join-all": true,
                },
                mark: "group-join",
              });
              runtime.log?.(`[tlon] Joined group ${approval.groupFlag} after approval`);
              setTimeout(() => {
                void (async () => {
                  try {
                    const newCount = await refreshWatchedChannels();
                    if (newCount > 0) {
                      runtime.log?.(
                        `[tlon] Discovered ${newCount} new channel(s) after joining group`,
                      );
                    }
                  } catch (error) {
                    runtime.log?.(
                      `[tlon] Channel discovery after group join failed: ${String(error)}`,
                    );
                  }
                })();
              }, 2000);
            } catch (error) {
              runtime.error?.(
                `[tlon] Failed to join group ${approval.groupFlag}: ${String(error)}`,
              );
            }
          }
          break;
        }
      }

      await sendOwnerNotification(formatApprovalConfirmation(approval, "approve"));
    } else if (parsed.action === "block") {
      await blockShip(approval.requestingShip);
      await sendOwnerNotification(formatApprovalConfirmation(approval, "block"));
    } else {
      await sendOwnerNotification(formatApprovalConfirmation(approval, "deny"));
    }

    setPendingApprovals(removePendingApproval(getPendingApprovals(), approval.id));
    await savePendingApprovals();
    return true;
  };

  const handleAdminCommand = async (text: string): Promise<boolean> => {
    const command = parseAdminCommand(text);
    if (!command) {
      return false;
    }

    switch (command.type) {
      case "blocked": {
        const blockedShips = await getBlockedShips();
        await sendOwnerNotification(formatBlockedList(blockedShips));
        runtime.log?.(`[tlon] Owner requested blocked ships list (${blockedShips.length} ships)`);
        return true;
      }
      case "pending": {
        await sendOwnerNotification(formatPendingList(getPendingApprovals()));
        runtime.log?.(
          `[tlon] Owner requested pending approvals list (${getPendingApprovals().length} pending)`,
        );
        return true;
      }
      case "unblock": {
        const shipToUnblock = command.ship;
        if (!(await isShipBlocked(shipToUnblock))) {
          await sendOwnerNotification(`${shipToUnblock} is not blocked.`);
          return true;
        }
        const success = await unblockShip(shipToUnblock);
        await sendOwnerNotification(
          success ? `Unblocked ${shipToUnblock}.` : `Failed to unblock ${shipToUnblock}.`,
        );
        return true;
      }
    }
  };

  return {
    handleAdminCommand,
    handleApprovalResponse,
    queueApprovalRequest,
  };
}
