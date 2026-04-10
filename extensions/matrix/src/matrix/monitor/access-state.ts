import { normalizeMatrixAllowList, resolveMatrixAllowListMatch } from "./allowlist.js";
import type { MatrixAllowListMatch } from "./allowlist.js";

interface MatrixCommandAuthorizer {
  configured: boolean;
  allowed: boolean;
}

export interface MatrixMonitorAccessState {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  effectiveRoomUsers: string[];
  groupAllowConfigured: boolean;
  directAllowMatch: MatrixAllowListMatch;
  roomUserMatch: MatrixAllowListMatch | null;
  groupAllowMatch: MatrixAllowListMatch | null;
  commandAuthorizers: [MatrixCommandAuthorizer, MatrixCommandAuthorizer, MatrixCommandAuthorizer];
}

export function resolveMatrixMonitorAccessState(params: {
  allowFrom: (string | number)[];
  storeAllowFrom: (string | number)[];
  groupAllowFrom: (string | number)[];
  roomUsers: (string | number)[];
  senderId: string;
  isRoom: boolean;
}): MatrixMonitorAccessState {
  const effectiveAllowFrom = normalizeMatrixAllowList([
    ...params.allowFrom,
    ...params.storeAllowFrom,
  ]);
  const effectiveGroupAllowFrom = normalizeMatrixAllowList(params.groupAllowFrom);
  const effectiveRoomUsers = normalizeMatrixAllowList(params.roomUsers);

  const directAllowMatch = resolveMatrixAllowListMatch({
    allowList: effectiveAllowFrom,
    userId: params.senderId,
  });
  const roomUserMatch =
    params.isRoom && effectiveRoomUsers.length > 0
      ? resolveMatrixAllowListMatch({
          allowList: effectiveRoomUsers,
          userId: params.senderId,
        })
      : null;
  const groupAllowMatch =
    effectiveGroupAllowFrom.length > 0
      ? resolveMatrixAllowListMatch({
          allowList: effectiveGroupAllowFrom,
          userId: params.senderId,
        })
      : null;

  return {
    commandAuthorizers: [
      {
        allowed: directAllowMatch.allowed,
        configured: effectiveAllowFrom.length > 0,
      },
      {
        allowed: roomUserMatch?.allowed ?? false,
        configured: effectiveRoomUsers.length > 0,
      },
      {
        allowed: groupAllowMatch?.allowed ?? false,
        configured: effectiveGroupAllowFrom.length > 0,
      },
    ],
    directAllowMatch,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
    groupAllowConfigured: effectiveGroupAllowFrom.length > 0,
    groupAllowMatch,
    roomUserMatch,
  };
}
