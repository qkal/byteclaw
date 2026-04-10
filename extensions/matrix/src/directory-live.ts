import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveMatrixAuth } from "./matrix/client.js";
import { MatrixAuthedHttpClient } from "./matrix/sdk/http-client.js";
import { isMatrixQualifiedUserId, normalizeMatrixMessagingTarget } from "./matrix/target-ids.js";
import type { ChannelDirectoryEntry } from "./runtime-api.js";

interface MatrixUserResult {
  user_id?: string;
  display_name?: string;
}

interface MatrixUserDirectoryResponse {
  results?: MatrixUserResult[];
}

interface MatrixJoinedRoomsResponse {
  joined_rooms?: string[];
}

interface MatrixRoomNameState {
  name?: string;
}

interface MatrixAliasLookup {
  room_id?: string;
}

interface MatrixDirectoryLiveParams {
  cfg: unknown;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}

type MatrixResolvedAuth = Awaited<ReturnType<typeof resolveMatrixAuth>>;

const MATRIX_DIRECTORY_TIMEOUT_MS = 10_000;

function resolveMatrixDirectoryLimit(limit?: number | null): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : 20;
}

function createMatrixDirectoryClient(auth: MatrixResolvedAuth): MatrixAuthedHttpClient {
  return new MatrixAuthedHttpClient({
    accessToken: auth.accessToken,
    dispatcherPolicy: auth.dispatcherPolicy,
    homeserver: auth.homeserver,
    ssrfPolicy: auth.ssrfPolicy,
  });
}

async function resolveMatrixDirectoryContext(params: MatrixDirectoryLiveParams): Promise<{
  auth: MatrixResolvedAuth;
  client: MatrixAuthedHttpClient;
  query: string;
  queryLower: string;
} | null> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return null;
  }
  const auth = await resolveMatrixAuth({ accountId: params.accountId, cfg: params.cfg as never });
  return {
    auth,
    client: createMatrixDirectoryClient(auth),
    query,
    queryLower: normalizeLowercaseStringOrEmpty(query),
  };
}

function createGroupDirectoryEntry(params: {
  id: string;
  name: string;
  handle?: string;
}): ChannelDirectoryEntry {
  return {
    handle: params.handle,
    id: params.id,
    kind: "group",
    name: params.name,
  } satisfies ChannelDirectoryEntry;
}

async function requestMatrixJson<T>(
  client: MatrixAuthedHttpClient,
  params: {
    method: "GET" | "POST";
    endpoint: string;
    body?: unknown;
  },
): Promise<T> {
  return (await client.requestJson({
    body: params.body,
    endpoint: params.endpoint,
    method: params.method,
    timeoutMs: MATRIX_DIRECTORY_TIMEOUT_MS,
  })) as T;
}

export async function listMatrixDirectoryPeersLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return [];
  }
  const directUserId = normalizeMatrixMessagingTarget(query);
  if (directUserId && isMatrixQualifiedUserId(directUserId)) {
    return [{ id: directUserId, kind: "user" }];
  }
  const context = await resolveMatrixDirectoryContext({
    ...params,
    query,
  });
  if (!context) {
    return [];
  }

  const res = await requestMatrixJson<MatrixUserDirectoryResponse>(context.client, {
    body: {
      limit: resolveMatrixDirectoryLimit(params.limit),
      search_term: context.query,
    },
    endpoint: "/_matrix/client/v3/user_directory/search",
    method: "POST",
  });
  const results = res.results ?? [];
  return results
    .map((entry) => {
      const userId = normalizeOptionalString(entry.user_id);
      if (!userId) {
        return null;
      }
      const displayName = normalizeOptionalString(entry.display_name);
      return {
        handle: displayName ? `@${displayName}` : undefined,
        id: userId,
        kind: "user",
        name: displayName,
        raw: entry,
      } satisfies ChannelDirectoryEntry;
    })
    .filter(Boolean) as ChannelDirectoryEntry[];
}

async function resolveMatrixRoomAlias(
  client: MatrixAuthedHttpClient,
  alias: string,
): Promise<string | null> {
  try {
    const res = await requestMatrixJson<MatrixAliasLookup>(client, {
      endpoint: `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      method: "GET",
    });
    return normalizeOptionalString(res.room_id) ?? null;
  } catch {
    return null;
  }
}

async function fetchMatrixRoomName(
  client: MatrixAuthedHttpClient,
  roomId: string,
): Promise<string | null> {
  try {
    const res = await requestMatrixJson<MatrixRoomNameState>(client, {
      endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
      method: "GET",
    });
    return normalizeOptionalString(res.name) ?? null;
  } catch {
    return null;
  }
}

export async function listMatrixDirectoryGroupsLive(
  params: MatrixDirectoryLiveParams,
): Promise<ChannelDirectoryEntry[]> {
  const query = normalizeOptionalString(params.query) ?? "";
  if (!query) {
    return [];
  }
  const directTarget = normalizeMatrixMessagingTarget(query);

  if (directTarget?.startsWith("!")) {
    return [createGroupDirectoryEntry({ id: directTarget, name: directTarget })];
  }

  const context = await resolveMatrixDirectoryContext({
    ...params,
    query,
  });
  if (!context) {
    return [];
  }
  const { client, queryLower } = context;
  const limit = resolveMatrixDirectoryLimit(params.limit);

  if (directTarget?.startsWith("#")) {
    const roomId = await resolveMatrixRoomAlias(client, directTarget);
    if (!roomId) {
      return [];
    }
    return [createGroupDirectoryEntry({ handle: directTarget, id: roomId, name: directTarget })];
  }

  const joined = await requestMatrixJson<MatrixJoinedRoomsResponse>(client, {
    endpoint: "/_matrix/client/v3/joined_rooms",
    method: "GET",
  });
  const rooms = (joined.joined_rooms ?? [])
    .map((roomId) => normalizeOptionalString(roomId))
    .filter((roomId): roomId is string => Boolean(roomId));
  const results: ChannelDirectoryEntry[] = [];

  for (const roomId of rooms) {
    const name = await fetchMatrixRoomName(client, roomId);
    if (!name || !normalizeLowercaseStringOrEmpty(name).includes(queryLower)) {
      continue;
    }
    results.push({
      handle: `#${name}`,
      id: roomId,
      kind: "group",
      name,
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}
